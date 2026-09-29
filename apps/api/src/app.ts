import Fastify from 'fastify';
import type { IncomingMessage } from 'http';
import { randomUUID } from 'crypto';
import {healthRoutes} from './routes/health.js';
import { AppError } from './errors/app-error.js'

export function buildApp(){
    const app = Fastify({
        logger: true,

        genReqId: (req : IncomingMessage) =>{
            const incomingReqId = req.headers["x-request-id"];

            if(typeof incomingReqId === "string" && incomingReqId.length > 0){
                return incomingReqId;
            }

            return randomUUID();
        },
    });

    app.addHook("onSend", async (request, reply, payload) => {
        reply.header("x-request-id", request.id);

        return payload;
    });

    app.setErrorHandler((error, request, reply) => {
            request.log.error({ err: error }, "Request failed");

            if (error instanceof AppError) {
                return reply.status(error.statusCode).send({
                    error: {
                        code: error.code,
                        message: error.message,
                        requestId: request.id,
                    },
                });
            }

            return reply.status(500).send({
                error: {
                    code: "INTERNAL_ERROR",
                    message: "An unexpected error occurred",
                    requestId: request.id,
                },
            });
        });

    app.register(healthRoutes);

    return app;
}

