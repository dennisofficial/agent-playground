import { Injectable } from "@nestjs/common";
import { query } from "@anthropic-ai/claude-agent-sdk";

@Injectable()
export class RunnerService {
  async run() {
    const stream = query({
      prompt: "",
      options: {
      }
    });

    for await (const chunk of stream) {
      console.log(chunk);
    }
  }
}
