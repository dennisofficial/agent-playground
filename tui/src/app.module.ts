import { Module } from "@nestjs/common";
import { AppServicesModule } from "./app/app-services.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { EngineModule } from "./engine/engine.module.js";
import { StoreModule } from "./store/store.module.js";

@Module({
  imports: [StoreModule, AuthModule, EngineModule, AppServicesModule],
})
export class AppModule {}
