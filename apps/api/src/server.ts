import { buildApp } from "./app.js";
import { env } from "@ticket-platform/config";

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection", reason);
  process.exit(1);
});

const app = buildApp();

try {
  await app.listen({  //app.listen is used to start the server and listen for
    host: "127.0.0.1",  //incoming requests on the specified host and port. also it is asynchronous function that return a promise
    port: env.PORT,
  });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}