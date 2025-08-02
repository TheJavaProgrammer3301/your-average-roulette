import { Router } from "@tsndr/cloudflare-worker-router";

const router = new Router<Env>();

type Game = {
	id: number,
	name: string,
	description: string | null,
	isArchived: boolean,
	rootPlaceId: number,
	privacyType: "Private" | "Public" | "FriendsOnly",
	creatorType: "User",
	creatorTargetId: number,
	creatorName: string,
	created: string,
	updated: string
}

type GameMedia = {
	assetTypeId: 0,
	assetType: string,
	imageId: 0,
	videoHash: string,
	videoTitle: string,
	approved: true,
	altText: string,
	videoId: string
}

type GameVersion = {
	Id: number,
	assetId: number,
	assetVersionNumber: number,
	creatorType: "User",
	creatorTargetId: number,
	creatingUniverseId: number | null,
	created: string,
	isPublished: false
}

type RouletteGame = {
	roblox: Game,
	media: GameMedia[],
	versions: GameVersion[]
}

async function getAllGames(env: Env, showArchived = false): Promise<Game[]> {
	const route = `https://apis.roblox.com/universes/v1/search?CreatorType=User&CreatorTargetId=${env.ROBLOX_USER_ID}&IsArchived=${showArchived}&PageSize=1000&SortParam=LastUpdated&SortOrder=Desc`

	const response = await fetch(route, {
		headers: {
			"Cookie": `.ROBLOSECURITY=${await env.ROBLOX_SECURITY_1.get()}${await env.ROBLOX_SECURITY_2.get()}`,
		}
	}).then(res => res.json()) as { data: Game[] };

	return response.data as Game[];
}

async function getGameMedia(env: Env, gameId: number): Promise<GameMedia[]> {
	const route = `https://games.roblox.com/v2/games/${gameId}/media`;

	const response = await fetch(route, {
		headers: {
			"Cookie": `.ROBLOSECURITY=${await env.ROBLOX_SECURITY_1.get()}${await env.ROBLOX_SECURITY_2.get()}`,
		}
	}).then(res => res.json()) as { data: GameMedia[] };
	
	return response.data as GameMedia[];
}

async function getGameVersions(env: Env, rootPlaceId: number): Promise<GameVersion[]> {
	let versions: GameVersion[] = [];
	let cursor: string | null = "";

	do {
		const route = `https://develop.roblox.com/v1/assets/${rootPlaceId}/saved-versions?limit=100&cursor=${cursor}`;

		const response = await fetch(route, {
			headers: {
				"Cookie": `.ROBLOSECURITY=${await env.ROBLOX_SECURITY_1.get()}${await env.ROBLOX_SECURITY_2.get()}`,
			}
		}).then(res => res.json()) as { data: GameVersion[], nextPageCursor: string | null };

		versions = versions.concat(response.data);
		cursor = response.nextPageCursor;
	} while (cursor);

	return versions;
}

async function getGameMetadata(env: Env, game: Game) {
	const newGame = { roblox: game, media: [], versions: [] } as RouletteGame;

	newGame.media = await getGameMedia(env, game.id);
	newGame.versions = await getGameVersions(env, game.rootPlaceId);

	return newGame;
}

router.get("/roulette", async (request) => {
	const env = request.env as Env;

	try {
		const games = await getAllGames(env);
		const randomGame = games[Math.floor(Math.random() * games.length)];
		const data = await getGameMetadata(request.env, randomGame);

		return new Response(JSON.stringify(data), {
			headers: { "Content-Type": "application/json" },
			status: 200
		});
	} catch (error) {
		console.error("Error fetching games:", error);

		return new Response("Failed to fetch games", { status: 500 });
	}
});

export default {
	async fetch(request, env, ctx): Promise<Response> {
		return router.handle(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
