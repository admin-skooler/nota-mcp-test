#!/usr/bin/env node

// Allows loading .env file for configuration if present
import 'dotenv/config';

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// --- Configuration ---
const FASTAPI_BASE_URL = process.env.FASTAPI_URL || "http://localhost:4000"; // Use env var or default
const GENERATE_TESTS_ENDPOINT = "/api/generate-tests";
const RUN_TASK_ENDPOINT = "/api/runtask";
const USER_AGENT = "mcp-test-runner/1.0";

// --- Zod Schema for Tool Arguments ---
// Used internally for validation within the CallTool handler
const ToolArgumentsSchema = z.object({
  url: z.string().url().describe("The target URL for the test case."),
  input_goal: z.string().describe("The goal or objective of the input/test."),
  placeholders: z
    .record(z.string(), z.string())
    .default({})
    .describe(
      "Key-value pairs for placeholders needed for the test or generation.",
    ),
  workflow_run_id: z
    .string()
    .describe("Identifier for the specific workflow run."),
});

// Type helper for validated arguments (optional but good practice)
type ToolArguments = z.infer<typeof ToolArgumentsSchema>;

// --- Create Server Instance ---
const server = new Server(
  {
    name: "test_runner", // Your server name
    version: "1.0.0",    // Your server version
    description: "MCP Server for generating and executing test cases via a FastAPI backend.", // Optional description
  },
  {
    capabilities: {
      tools: {}, // Indicate that this server provides tools
    },
  }
);

// --- List Available Tools Handler ---
server.setRequestHandler(ListToolsRequestSchema, async () => {
  console.error("MCP: Received ListTools request."); // Log to stderr
  return {
    tools: [
      {
        name: "generate-test-case",
        description: "Generates test case data based on URL, goal, placeholders, and workflow ID.",
        // Provide input schema in JSON Schema format for the client
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", format: "uri", description: "The target URL for the test case." },
            input_goal: { type: "string", description: "The goal or objective of the input/test." },
            placeholders: {
              type: "object",
              additionalProperties: { type: "string" },
              description: "Key-value pairs for placeholders needed for the test or generation.",
              default: {} // Indicate default
            },
            workflow_run_id: { type: "string", description: "Identifier for the specific workflow run." },
          },
          // Specify required properties (placeholders has a default, so may not be strictly required by client)
          required: ["url", "input_goal", "workflow_run_id"],
        },
      },
      {
        name: "execute-test-case",
        description: "Executes a test task based on URL, goal, placeholders, and workflow ID.",
        // Same input schema as generate-test-case
        inputSchema: {
           type: "object",
          properties: {
            url: { type: "string", format: "uri", description: "The target URL for the test case." },
            input_goal: { type: "string", description: "The goal or objective of the input/test." },
            placeholders: {
              type: "object",
              additionalProperties: { type: "string" },
              description: "Key-value pairs for placeholders needed for the test or generation.",
              default: {}
            },
            workflow_run_id: { type: "string", description: "Identifier for the specific workflow run." },
          },
          required: ["url", "input_goal", "workflow_run_id"],
        },
      },
    ],
  };
});

// --- Helper Function for making API requests to the FastAPI backend ---
async function makeApiRequest<T>(
  endpoint: string,
  payload: ToolArguments, // Expect validated arguments
): Promise<T | null> {
  const url = `${FASTAPI_BASE_URL}${endpoint}`;
  const headers = {
    "User-Agent": USER_AGENT,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  try {
    // Log to stderr to avoid interfering with MCP communication
    console.error(`MCP: Making POST request to ${url}`);
    const response = await fetch(url, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(
        `MCP: HTTP error! Status: ${response.status}, URL: ${url}, Body: ${errorBody}`,
      );
      throw new Error(
        `HTTP error! status: ${response.status}. Response: ${errorBody}`,
      );
    }

    const responseData = (await response.json()) as T;
    console.error(`MCP: Received successful response from ${url}`);
    return responseData;
  } catch (error) {
    console.error(`MCP: Error making API request to ${url}:`, error);
    return null; // Indicate failure
  }
}

// --- Handle Tool Execution ---
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  console.error(`MCP: Received CallTool request for "${name}" with args:`, args); // Log request

  try {
    // 1. Validate the incoming arguments using our Zod schema
    // ZodError will be caught by the catch block if parsing fails
    const validatedArgs = ToolArgumentsSchema.parse(args);

    let apiEndpoint: string;
    let successMessagePrefix: string;
    let failureMessage: string;

    // 2. Determine which API endpoint to call based on the tool name
    if (name === "generate-test-case") {
      apiEndpoint = GENERATE_TESTS_ENDPOINT;
      successMessagePrefix = "MCP: Test case generation initiated.";
      failureMessage = "MCP: Failed to generate test case via backend.";
    } else if (name === "execute-test-case") {
      apiEndpoint = RUN_TASK_ENDPOINT;
      successMessagePrefix = "MCP: Test case execution initiated.";
      failureMessage = "MCP: Failed to execute test case via backend.";
    } else {
      // 3. Handle unknown tool names
      console.error(`MCP: Unknown tool requested: ${name}`);
      throw new Error(`Unknown tool: ${name}`);
    }

    // 4. Call the appropriate backend API
    const responseData = await makeApiRequest<unknown>(apiEndpoint, validatedArgs);

    // 5. Handle the API response
    if (!responseData) {
      return { content: [{ type: "text", text: failureMessage }] };
    }

    // 6. Format the successful response for the MCP client
    const responseText = `${successMessagePrefix} Response:\n\`\`\`json\n${JSON.stringify(responseData, null, 2)}\n\`\`\``;
    return {
      content: [
        {
          type: "text",
          text: responseText,
        },
      ],
    };

  } catch (error) {
    // 7. Handle errors, including validation errors
    console.error(`MCP: Error processing tool "${name}":`, error); // Log the error to stderr
    if (error instanceof z.ZodError) {
      // Format Zod validation errors clearly
      const errorMessages = error.errors.map(e => `${e.path.join('.') || 'arguments'}: ${e.message}`).join('; ');
      // Throw an error that the SDK might catch and format as an MCP error response
      throw new Error(`Invalid arguments for tool "${name}": ${errorMessages}`);
    }
    // Re-throw other errors
    throw error;
  }
});

// --- Start the Server ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log status messages to stderr
  console.error("Test Runner MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});