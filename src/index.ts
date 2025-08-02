import { Router } from "@tsndr/cloudflare-worker-router";

const router = new Router<Env>();

router.get("/roulette", async (request) => {
	let headers = [];
	
	for (const [key, value] of request.req.headers) {
		headers.push(`${key}: ${value}`);
	}

	console.log(headers.join("\n"));
});

export default {
	async fetch(request, env, ctx): Promise<Response> {
		return router.handle(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
