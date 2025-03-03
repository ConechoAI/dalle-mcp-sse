#!/usr/bin/env node

import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {CallToolRequestSchema, ListToolsRequestSchema, Tool} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import * as dotenv from 'dotenv';
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { SSERedisTransport } from './redis_transport'

dotenv.config();

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY) {
  throw new Error("OPENAI_API_KEY environment variable is required");
}
const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";


interface DalleResponse {
    // Response structure from Dalle API
    created: number;
    data?: Array<{
      url: string;
    }>;
  }

class DallEClient {
  // Core client properties
  private server: Server;
  private axiosInstance;
  private baseURLs = {
    generate: 'https://api.openai.com/v1/images/generations',
  };

  constructor() {
    this.server = new Server(
      {
        name: "dalle-mcp-sse",
        version: "0.1.0",
      },
      {
        capabilities: {
          resources: {},
          tools: {},
          prompts: {},
        },
      }
    );

    this.axiosInstance = axios.create({
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'Authorization': 'Bearer ' + API_KEY
      }
    });

    this.setupHandlers();
    this.setupErrorHandling();
  }

  private setupErrorHandling(): void {
    this.server.onerror = (error) => {
      console.error("[MCP Error]", error);
    };

    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupHandlers(): void {
    this.setupToolHandlers();
  }

  private setupToolHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      // Define available tools: tavily-search and tavily-extract
      const tools: Tool[] = [
        {
          name: "generate",
          description: "Creates an image given a prompt.",
          inputSchema: {
            type: "object",
            properties: {
                prompt: { 
                type: "string", 
                description: "The prompt to generate an image from" 
              },
            },
            required: ["prompt"]
          }
        },
      ];
      return { tools };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        let response: DalleResponse;
        const args = request.params.arguments ?? {};

        switch (request.params.name) {
          case "generate":
            response = await this.search({
              prompt: args.prompt,
            });
            break;

          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${request.params.name}`
            );
        }

        return {
          content: [{
            type: "text",
            text: formatResults(response)
          }]
        };
      } catch (error: any) {
        if (axios.isAxiosError(error)) {
          return {
            content: [{
              type: "text",
              text: `Dalle API error: ${error.response?.data?.message ?? error.message}`
            }],
            isError: true,
          }
        }
        throw error;
      }
    });
  }


  async run(): Promise<void> {
    const app = express();
    app.use(express.json());
    
    app.get("/sse", async (req: any, res: any) => {
      console.log("Received connection");
      const transport = new SSERedisTransport("/messages", res, REDIS_URL as string);
      // console.log("Connecting transport", transport);
      await this.server.connect(transport);
    });
    
    app.post("/messages", async (req: any, res: any) => {
      console.log("Received message");
      const sessionId = req.query.sessionId;
      console.log("Session ID", sessionId);
      const transport = new SSERedisTransport("/messages", sessionId, REDIS_URL as string);
      // console.log("Connecting transport", transport);
      await this.server.connect(transport);

      let body = req.body
      if (body.method === "tools/call") {
        const token = body.params._meta.token
        console.log("Token", token)
        const userInfo = await this.fetchUserInfo(token)
        console.log("User info", userInfo)
        if (!userInfo) {
          transport
          ?.send({
            jsonrpc: "2.0",
            id: body.id,
            error: {
              code: ErrorCode.InvalidRequest,
              message: "Invalid token",
            },
          });
          return;
        }
      }

      await transport.handlePostMessage(req, res);
    });
    
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  }

  async fetchUserInfo(token: string): Promise<any> {
    try {
      // 模拟请求：根据 jwt 获取用户账户信息
      // 你可以替换下面的代码为实际的 API 请求
      const response = await fetch('https://api.conecho.ai/api/account', {
        method: 'GET',
        // credentials: 'include',  // 跨域请求也会发送 jwt
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,  // 携带 token
        },
      });
      if (response.ok) {
        const data = await response.json();
        if (!data) {
          return
        }
        return data;
      } else {
        return
      }
    } catch (error) {
      return
    }
  }

  async search(params: any): Promise<DalleResponse> {
    try {
      // Choose endpoint based on whether it's an extract request
      const endpoint = this.baseURLs.generate;
      
      // Add topic: "news" if query contains the word "news"
      const searchParams = {
        ...params,
        model: 'dall-e-3',
        n: 1,
        size: "1024x1024"
      };
      
      const response = await this.axiosInstance.post(endpoint, searchParams);
      return response.data;
    } catch (error: any) {
      if (error.response?.status === 401) {
        throw new Error('Invalid API key');
      } else if (error.response?.status === 429) {
        throw new Error('Usage limit exceeded');
      }
      throw error;
    }
  }
}

function formatResults(response: DalleResponse): string {
  // Format API response into human-readable text
  const output: string[] = [];

  // Include image if available
  if (response.data && response.data?.length > 0) {
    output.push(`Image url: ${response.data[0].url}`);
    output.push('');
  }
  return output.join('\n');
}

export async function serve(): Promise<void> {
  const client = new DallEClient();
  await client.run();
}

const server = new DallEClient();
server.run().catch(console.error);
