import { Module } from "@nestjs/common";
import { AccountVaultService } from "./account-vault.service.js";
import { EngineHomeService } from "./engine-home.service.js";
import { ClaudeOAuthClient } from "./oauth/claude-oauth.client.js";
import { ClaudeUsageClient } from "./oauth/claude-usage.client.js";
import { SecretCipherService } from "./secret-cipher.service.js";

@Module({
  providers: [
    SecretCipherService,
    ClaudeOAuthClient,
    ClaudeUsageClient,
    AccountVaultService,
    EngineHomeService,
  ],
  exports: [
    ClaudeOAuthClient,
    ClaudeUsageClient,
    AccountVaultService,
    EngineHomeService,
  ],
})
export class AuthModule {}
