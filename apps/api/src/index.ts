import { env } from "@ticket-platform/config";

console.log({
  nodeEnv: env.NODE_ENV,
  port: env.PORT,
});