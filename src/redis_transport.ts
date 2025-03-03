import { IncomingMessage, ServerResponse } from "node:http";
import { createClient } from 'redis';
import { randomUUID } from "node:crypto";
import contentType from "content-type";
import getRawBody from "raw-body";
import { JSONRPCMessage, JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport";

// 基础传输类
class SSERedisTransportBase implements Transport{
  onmessage?: ((message: JSONRPCMessage) => void) | undefined; 
  onerror?: ((error: Error) => void) | undefined;
  _endpoint: string;
  _redisClient: any;
  _isStarted: boolean;
  constructor(endpoint: string, redisURL: string) {
    this._endpoint = endpoint;
    this._redisClient = createClient({ url: redisURL });
    this._redisClient.on('error', (err: any) => console.error('Redis Client Error', err));
    this._isStarted = false;
  }

  async start(): Promise<any> {
    if (!this._isStarted) {
      await this._redisClient.connect();
      this._isStarted = true;
    }
    console.debug('Redis client connected');
  }

  async close() {
    if (this._isStarted) {
      await this._redisClient.disconnect();
      this._isStarted = false;
    }
    console.debug('Redis client disconnected');
  }

  getChannelName(sessionId: string) {
    return `sse:channel:${sessionId}`;
  }
  async send(message: JSONRPCMessage): Promise<void> {
    throw new Error("Method not implemented.");
  }
}

// 订阅端实现
class SSESubscribeTransport extends SSERedisTransportBase {
  _sseResponse: any
  _sessionId: string;
  _subscriberClient: any;
  constructor(endpoint: string, res: any, redisURL: string) {
    super(endpoint, redisURL);
    this._sseResponse = res;
    this._sessionId = randomUUID()
  }

  async start(): Promise<any> {
    await super.start();
    // 创建单独的订阅客户端
    this._subscriberClient = this._redisClient.duplicate();
    await this._subscriberClient.connect();
    
    const channel = this.getChannelName(this.getSessionId());

    console.debug('Subscribing to channel:', channel);
    
    await this._subscriberClient.subscribe(channel, (message: string) => {
      try {
        const data = JSON.parse(message);
        this._sseResponse.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch (error) {
        console.error('Error handling SSE message:', error);
      }
    });
    this._sseResponse.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    });
    this._sseResponse.write(`event: endpoint\ndata: ${encodeURI(this._endpoint)}?sessionId=${this._sessionId}\n\n`);
    // 返回会话ID以供发布端使用
    return this.getSessionId();
  }

  // 走一遍server的onmessage逻辑会触发transport的send方法
  async send(message: JSONRPCMessage): Promise<void> {
    this._sseResponse.write(`data: ${JSON.stringify(message)}\n\n`);
  }

  async close() {
    if (this._subscriberClient) {
      const channel = this.getChannelName(this.getSessionId());
      await this._subscriberClient.unsubscribe(channel);
      await this._subscriberClient.disconnect();
    }
    await super.close();
  }

  getSessionId() {
    return this._sessionId;
  }
}

// 发布端实现
class SSEPublishTransport extends SSERedisTransportBase implements Transport {
  _sessionId: string;
  constructor(endpoint: string, sessionId: string, redisURL: string) {
    super(endpoint, redisURL);
    this._sessionId = sessionId;
  }
  
  /**
   * 实现与 SSEServerTransport 兼容的 handlePostMessage 方法
   * @param {Object} req - HTTP 请求对象（不使用，保持接口一致）
   * @param {Object} res - HTTP 响应对象（不使用，保持接口一致）
   * @returns {Promise<void>}
   */
  async handlePostMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // @ts-ignore
      let body = req.body
      if (!body) {
        const contentTypeHeader = req.headers['content-type'];
        const ct = contentType.parse(contentTypeHeader as string);
        if (ct.type !== 'application/json') {
          throw new Error('Unsupported content type');
        }
        body = await getRawBody(req, { encoding: ct.parameters.charset || 'utf-8' });
      }
      const message: any = JSON.parse(body);
      const parsedMessage = JSONRPCMessageSchema.parse(message);
      this.onmessage?.(parsedMessage);
    } catch (error) {
      console.error('Error in handlePostMessage:', error);
      throw error;
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this._isStarted) {
      await this.start();
    }

    const channel = this.getChannelName(this._sessionId);
    await this._redisClient.publish(channel, JSON.stringify(message));
    await this.close();
  }
}

export {
    SSESubscribeTransport,
    SSEPublishTransport
}
