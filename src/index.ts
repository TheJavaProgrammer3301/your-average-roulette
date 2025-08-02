import { Router } from "@tsndr/cloudflare-worker-router";

const router = new Router<Env>();

router.get("/roulette", async (request) => {
	console.log(request.req.headers);
});

export default {
	async fetch(request, env, ctx): Promise<Response> {
		return router.handle(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
