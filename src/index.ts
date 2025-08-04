import { Router } from "@tsndr/cloudflare-worker-router";

const router = new Router<Env>();

export type Game = {
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

export type GameMedia = {
	assetTypeId: 0,
	assetType: string,
	imageId: 0,
	videoHash: string,
	videoTitle: string,
	approved: true,
	altText: string,
	videoId: string
}

export type GameVersion = {
	Id: number,
	assetId: number,
	assetVersionNumber: number,
	creatorType: "User",
	creatorTargetId: number,
	creatingUniverseId: number | null,
	created: string,
	isPublished: false
}

export type GameMetrics = {
	spins: number,
	teleports: number,
	missedTeleports: number
}

export type RouletteGame = {
	roblox: Game,
	media: GameMedia[],
	versions: GameVersion[],
	metrics: GameMetrics
}

async function getAllGames(env: Env, showArchived = false): Promise<Game[]> {
	const route = `https://apis.roblox.com/universes/v1/search?CreatorType=${env.ROBLOX_AUTHOR_TYPE}&CreatorTargetId=${env.ROBLOX_AUTHOR_ID}&IsArchived=${showArchived}&PageSize=1000&SortParam=LastUpdated&SortOrder=Desc`;

	console.log("fetch");
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

async function getGameVersions(env: Env, rootPlaceId: number, surelyDoesNotExistAlready = false): Promise<[GameVersion[], number]> {
	let versions: GameVersion[] = [];
	let cursor: string | null = "";

	// Check if we have cached versions in the database
	const currentTimeInSeconds = Math.floor(Date.now() / 1000);

	if (!surelyDoesNotExistAlready) {
		console.log("DB");
		const existingEntry = await env.DB.prepare("SELECT versions, updatedAt FROM versions WHERE place = ?")
			.bind(rootPlaceId)
			.first<{ versions: string, updatedAt: number }>();

		// Check if entry exists and is less than 7 days old
		const sevenDaysInSeconds = 7 * 24 * 60 * 60;

		if (existingEntry && (currentTimeInSeconds - existingEntry.updatedAt) < sevenDaysInSeconds) {
			return [JSON.parse(existingEntry.versions), 1];
		}
	}

	let requests = 1;

	// Fetch new data from API
	do {
		const route = `https://develop.roblox.com/v1/assets/${rootPlaceId}/saved-versions?limit=100&cursor=${cursor}`;

		console.log("fetch version");
		requests++;
		const response = await fetch(route, {
			headers: {
				"Cookie": `.ROBLOSECURITY=${await env.ROBLOX_SECURITY_1.get()}${await env.ROBLOX_SECURITY_2.get()}`,
			}
		}).then(res => res.json()) as { data: GameVersion[], nextPageCursor: string | null };

		versions = versions.concat(response.data);
		cursor = response.nextPageCursor;
	} while (cursor);

	// Store/update in database with current timestamp
	console.log("DB");
	await env.DB.prepare(`
		INSERT INTO versions (place, versions, updatedAt) 
		VALUES (?, ?, ?)
		ON CONFLICT(place) DO UPDATE SET versions = ?, updatedAt = ?
	`)
		.bind(rootPlaceId, JSON.stringify(versions), currentTimeInSeconds, JSON.stringify(versions), currentTimeInSeconds)
		.run();

	return [versions, requests];
}

async function getGameVersionsBatched(env: Env): Promise<Map<number, GameVersion[]>> {
	console.log("DB");
	const result = (await env.DB.prepare("SELECT place, versions FROM versions").all<{ place: number, versions: string }>()).results;

	const batchedVersions = new Map<number, GameVersion[]>();

	for (const row of result) {
		batchedVersions.set(row.place, JSON.parse(row.versions));
	}

	return batchedVersions;
}

async function getGameMetrics(env: Env, gameId: number): Promise<GameMetrics> {
	const result = await env.DB.prepare("SELECT spins, teleports, missedTeleports FROM metrics WHERE game = ?")
		.bind(gameId)
		.first<GameMetrics>();

	return result ?? {
		spins: 0,
		teleports: 0,
		missedTeleports: 0
	};
}

async function getGameMetadata(env: Env, game: Game) {
	const newGame = {
		roblox: game, media: [], versions: [], metrics: {
			spins: 0,
			teleports: 0,
			missedTeleports: 0
		}
	} as RouletteGame;

	console.warn("invoke");

	newGame.media = await getGameMedia(env, game.id);
	newGame.versions = (await getGameVersions(env, game.rootPlaceId))[0];
	newGame.metrics = await getGameMetrics(env, game.id);

	return newGame;
}

router.get("/roulette", async (request) => {
	const env = request.env as Env;

	try {
		const games = await getAllGames(env);
		const randomGame = games[Math.floor(Math.random() * games.length)];
		const data = await getGameMetadata(request.env, randomGame);

		// Insert or update metrics: increment spins if game exists, otherwise create new entry
		try {
			await env.DB.prepare(`
			INSERT INTO metrics (game, spins) 
			VALUES (?, 1)
			ON CONFLICT(game) DO UPDATE SET spins = spins + 1
		`)
				.bind(data.roblox.id)
				.run();
		} catch (error) {
			console.error("Error updating metrics:", error);

			return new Response("Failed to update metrics", { status: 500 });
		}

		return new Response(JSON.stringify(data), {
			headers: { "Content-Type": "application/json" },
			status: 200
		});
	} catch (error) {
		console.error("Error fetching games:", error);

		return new Response("Failed to fetch games", { status: 500 });
	}
});

router.put("/roulette/:gameId/metrics", async (request) => {
	const env = request.env as Env;
	const { teleports, missedTeleports, teleportedPlayers, missedPlayers } = await request.req.json() as { teleports: number, missedTeleports: number, teleportedPlayers: number[], missedPlayers: number[] };

	console.log(`Updating metrics for game ${request.req.params.gameId}: teleports=${teleports}, missedTeleports=${missedTeleports}`);

	try {
		// Update game metrics
		await env.DB.prepare(`UPDATE metrics SET teleports = teleports + ?, missedTeleports = missedTeleports + ? WHERE game = ?`)
			.bind(teleports, missedTeleports, request.req.params.gameId)
			.run();

		// Update player metrics for all players (increment spins)
		const allPlayers = [...teleportedPlayers, ...missedPlayers];
		for (const playerId of allPlayers) {
			await env.DB.prepare(`
				INSERT INTO playerMetrics (player, spins, teleports) 
				VALUES (?, 1, 0)
				ON CONFLICT(player) DO UPDATE SET spins = spins + 1
			`)
				.bind(playerId)
				.run();
		}

		// Update teleports for successfully teleported players
		for (const playerId of teleportedPlayers) {
			await env.DB.prepare(`
				INSERT INTO playerMetrics (player, spins, teleports) 
				VALUES (?, 1, 1)
				ON CONFLICT(player) DO UPDATE SET teleports = teleports + 1
			`)
				.bind(playerId)
				.run();
		}

		return new Response(null, { status: 204 });
	} catch (error) {
		console.error("Error updating player metrics:", error);
		return new Response("Failed to update player metrics", { status: 500 });
	}
});

router.get("/metrics/:player", async (request) => {
	const env = request.env as Env;
	const playerId = request.req.params.player;

	try {
		const metrics = await env.DB.prepare(`SELECT spins, teleports FROM playerMetrics WHERE player = ?`)
			.bind(playerId)
			.first();

		if (!metrics) {
			return new Response("Player metrics not found", { status: 404 });
		}

		return new Response(JSON.stringify(metrics), {
			headers: { "Content-Type": "application/json" },
			status: 200
		});
	} catch (error) {
		console.error("Error fetching player metrics:", error);
		return new Response("Failed to fetch player metrics", { status: 500 });
	}
});

router.get("/history", async (request) => {
	const env = request.env as Env;
	const versionMap = await getGameVersionsBatched(env);
	const allGames = await getAllGames(env);

	Object.keys(versionMap).forEach(key => {
		if (!allGames.some(game => game.rootPlaceId === parseInt(key))) {
			console.warn("remove");
			versionMap.delete(parseInt(key));
		}
	});

	let max = 25;
	let count = 0;

	const missingGames = allGames.filter(game => !versionMap.has(game.rootPlaceId));

	for (const game of missingGames) {
		if (count >= max) {
			// console.warn("Max version fetch limit reached");
			break;
		}
		console.log("Getting versions for game:", game.rootPlaceId);
		const [versions, requests] = await getGameVersions(env, game.rootPlaceId, true);
		versionMap.set(game.rootPlaceId, versions);
		count += requests;
		count++;
	}

	console.warn(count, max);

	const games = await Promise.all((await getAllGames(env)).map(async game => ({
		roblox: game,
		versions: versionMap.get(game.rootPlaceId),
	})));

	return Response.json({
		games
	});
});

export default {
	async fetch(request, env, ctx): Promise<Response> {
		return router.handle(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
