import type { FastifyInstance } from "fastify";

export function healthRoutes(app: FastifyInstance) : void{
    app.get("/health/live", ()=>{
        return { 
            status: "ok" 
        };
    });

    app.get("/health/ready", () =>{
        return {
            status: "ok"
        };
    });

}