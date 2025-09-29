#!/usr/bin/env node

import { existsSync as fileExists, readFileSync } from "node:fs";
import { readFile, unlink as unlinkFile, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { promisify } from "node:util";
import chalk from "ansi-colors";
import arg from "arg";
import enquirer from "enquirer";
import { JSDOM } from "jsdom";
import ProtobufJS from "protobufjs";
import SteamUser from "steam-user";

const setTimeoutAsync = promisify(setTimeout);
const { dirname } = import.meta;

// !!!
//
// "I receive a new item in my inventory" notification must be enabled
// https://store.steampowered.com/account/notificationsettings
//
// !!!

let MAX_APPS_AT_ONCE = 32; // how many apps to idle at once
let MIN_PLAYTIME_TO_IDLE = 180; // minimum playtime in minutes without cycling
let CYCLE_MINUTES_BETWEEN = 5;
let CYCLE_DELAY = 10000; // how many milliseconds to wait between cycling apps

interface AppWithDrops {
	appid: number;
	playtime: number;
	drops: number;
}

interface NotificationBody {
	app_id: string;
	context_id: string;
	source_appid: string;
}

interface SteamNotification {
	id: string;
	type: number;
	read: boolean;
	viewed: number;
	body: NotificationBody;
}

interface NotificationsPayload {
	notifications: SteamNotification[];
}

interface GetAppsToPlayResult {
	requiresIdling: boolean;
	appsToPlay: AppWithDrops[];
}

function arrayTakeFirst<T>(arr: T[], end: number): T[] {
	const result: T[] = [];

	for (let i = 0; i < end && i < arr.length; i += 1) {
		result.push(arr[i]);
	}

	return result;
}

function arrayShuffle<T>(array: T[]): void {
	let currentIndex = array.length;

	while (currentIndex !== 0) {
		const randomIndex = Math.floor(Math.random() * currentIndex);
		currentIndex -= 1;

		[array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
	}
}

class SteamCardFarmer {
	appsWithDrops: AppWithDrops[] = [];
	cookies: string[] = [];
	accountName = "";
	checkTimer = setTimeout(() => {}, 0);
	playStateBlocked = false;
	lastBadgesCheck = Date.now();
	privateApps = new Set<number>();
	dataDirectory = resolvePath(dirname, "./data/");

	client = new SteamUser({
		autoRelogin: false,
		dataDirectory: this.dataDirectory,
	});

	logOn(password: string | null = null, refreshToken: string | null = null): void {
		if (refreshToken) {
			this.client.logOn({
				refreshToken,
				machineName: "Steam-Card-Farmer",
				logonID: 66666666,
			});
		} else if (password) {
			this.client.logOn({
				accountName: this.accountName,
				password,
				machineName: "Steam-Card-Farmer",
				logonID: 66666666,
			});
		} else {
			throw new Error("No logon method specified");
		}
	}

	onLoggedIn(): void {
		this.log("Logged into Steam!");
		this.getPrivateApps();
	}

	async onRefreshToken(token: string): Promise<void> {
		await writeFile(this.getRefreshTokenFilename(), token, "utf8");
	}

	async onError(e: Error & { eresult: SteamUser.EResult }): Promise<void> {
		clearTimeout(this.checkTimer);

		if (e.eresult === SteamUser.EResult.LoggedInElsewhere) {
			this.playStateBlocked = true;

			this.log(chalk.red("Another client logged in elsewhere."));

			return;
		}

		const badTokenErrors = [
			SteamUser.EResult.AccessDenied,
			SteamUser.EResult.Expired,
			SteamUser.EResult.InvalidPassword,
			SteamUser.EResult.InvalidSignature,
			SteamUser.EResult.Revoked,
		];

		if (badTokenErrors.includes(e.eresult)) {
			await unlinkFile(this.getRefreshTokenFilename());
		}

		this.log(chalk.red(`${e.toString()} (${SteamUser.EResult[e.eresult] || e.eresult})`));
	}

	onDisconnected(eResult: SteamUser.EResult, msg?: string): void {
		clearTimeout(this.checkTimer);

		this.log(chalk.red(`Disconnected: ${msg} (${SteamUser.EResult[eResult] || eResult})`));

		this.checkTimer = setTimeout(() => this.client.logOn(true), 10000);
	}

	onPlayingState(blocked: boolean): void {
		if (this.playStateBlocked === blocked) {
			return;
		}

		this.playStateBlocked = blocked;

		if (blocked) {
			this.log(chalk.red("You started playing a game elsewhere, idling will resume when you quit."));
			return;
		}

		this.log(chalk.green("You are no longer playing a game elsewhere, resuming."));

		if (this.appsWithDrops.length > 0) {
			this.idle();
		}
	}

	onWebSession(_sessionID: string, cookies: string[]): void {
		this.cookies = cookies;
		this.cookies.push("Steam_Language=english");

		clearTimeout(this.checkTimer);
		this.checkTimer = setTimeout(() => {
			this.log("Web session received, checking badges...");
			this.appsWithDrops = [];
			this.requestBadgesPage(1);
		}, 1000 * 2);
	}

	async requestBadgesPage(page: number, syncOnly = false): Promise<void> {
		let document: Document;

		try {
			let url = "";

			if (this.client.vanityURL) {
				url = `id/${this.client.vanityURL}`;
			} else if (this.client.steamID) {
				url = `profiles/${this.client.steamID.getSteamID64()}`;
			} else {
				throw new Error("No SteamID or vanity URL.");
			}

			const headers = new Headers();
			headers.append("User-Agent", "Steam-Card-Farmer (+https://github.com/xPaw/Steam-Card-Farmer)");
			headers.append("Cookie", this.cookies.join("; "));

			const response = await fetch(`https://steamcommunity.com/${url}/badges/?l=english&p=${page}`, {
				headers,
				redirect: "error",
				signal: AbortSignal.timeout(10000),
			});

			if (response.status !== 200) {
				throw new Error(`HTTP error ${response.status}`);
			}

			const text = await response.text();

			if (text.includes("g_steamID = false")) {
				this.log(chalk.red(`Page ${page}: loaded, but it is logged out`));
				this.client.webLogOn();
				return;
			}

			const dom = new JSDOM(text);
			document = dom.window.document;
		} catch (err) {
			this.log(chalk.red(`Page ${page}: failed to load: ${err}`));

			this.checkTimer = setTimeout(() => this.requestBadgesPage(page, syncOnly), 30000);
			return;
		}

		let pageDrops = 0;
		let pageApps = 0;
		const appIdToApp = new Map<number, number>();

		for (let i = 0; i < this.appsWithDrops.length; i += 1) {
			appIdToApp.set(this.appsWithDrops[i].appid, i);
		}

		for (const infoline of document.querySelectorAll(".progress_info_bold")) {
			const match = infoline.textContent?.match(/(\d+)/);

			if (!match) {
				continue;
			}

			const row = infoline.closest(".badge_row");
			const href = row?.querySelector(".badge_title_playgame a")?.getAttribute("href");

			if (!row || !href) {
				continue;
			}

			const urlparts = href.split("/");
			const appid = Number.parseInt(urlparts[urlparts.length - 1], 10) || 0;
			const drops = Number.parseInt(match[1], 10) || 0;

			if (appid < 1 || drops < 1) {
				continue;
			}

			pageDrops += drops;
			pageApps += 1;

			let playtime = 0.0;
			const playTimeMatch = row
				.querySelector(".badge_title_stats_playtime")
				?.textContent?.match(/(?<playtime>\d+\.\d+)/);

			if (playTimeMatch?.groups?.playtime) {
				playtime = Number.parseFloat(playTimeMatch.groups.playtime) || 0.0;
				playtime = Math.round(playtime * 60);
			}

			if (this.privateApps.has(appid)) {
				this.log(chalk.red(`App ${appid} has ${drops} drops, but it cannot be idled because it is private.`));
				continue;
			}

			const app: AppWithDrops = {
				appid,
				playtime,
				drops,
			};

			const existingAppIndex = appIdToApp.get(appid);

			if (typeof existingAppIndex !== "undefined") {
				const existingApp = this.appsWithDrops[existingAppIndex];
				existingApp.drops = drops;
				existingApp.playtime = playtime;
				continue;
			}

			appIdToApp.set(appid, this.appsWithDrops.length);
			this.appsWithDrops.push(app);
		}

		if (pageDrops > 0) {
			this.log(
				`${chalk.green(`Page ${page}`)}: ${chalk.green(
					String(pageDrops),
				)} card drop${pageDrops === 1 ? "" : "s"} remaining across ${chalk.green(
					String(pageApps),
				)} app${pageApps === 1 ? "" : "s"}`,
			);
		} else {
			this.log(`${chalk.green(`Page ${page}`)}: no drops remaining`);
		}

		let lastPage = 0;
		const pageLinks = document.querySelectorAll(".pagelink");

		if (pageLinks.length > 0) {
			lastPage = Number.parseInt(pageLinks[pageLinks.length - 1].textContent || "1", 10) || 1;
		}

		if (page <= lastPage) {
			this.requestBadgesPage(page + 1, syncOnly);
		} else if (syncOnly) {
			// do nothing
		} else if (this.appsWithDrops.length > 0) {
			this.idle();
		} else {
			this.log(chalk.green("All card drops received!"));
			this.shutdown(0);
		}

		this.lastBadgesCheck = Date.now();
	}

	idle(): void {
		if (this.playStateBlocked) {
			this.log(chalk.red("Unable to idle cards while you are playing a game elsewhere."));
			return;
		}

		if (!this.client.steamID) {
			this.log(chalk.red("Unable to idle because disconnected from Steam."));
			return;
		}

		const totalDropsLeft = this.appsWithDrops.reduce((total, { drops }) => total + drops, 0);

		const temp = this.getAppsToPlay();
		let { requiresIdling } = temp;
		const { appsToPlay } = temp;
		const appids = appsToPlay.map(({ appid }) => appid);

		this.client.gamesPlayed(appids);

		let idleMinutes = CYCLE_MINUTES_BETWEEN;

		if (requiresIdling) {
			// take the median time until minimum playtime is reached and then check again
			const medianPlaytime = appsToPlay[Math.floor(appsToPlay.length / 2)];
			idleMinutes = MIN_PLAYTIME_TO_IDLE - medianPlaytime.playtime;

			if (idleMinutes < CYCLE_MINUTES_BETWEEN) {
				requiresIdling = false;
				idleMinutes = CYCLE_MINUTES_BETWEEN;
			}
		}

		if (requiresIdling) {
			this.log(
				`Idling ${chalk.green(String(appsToPlay.length))} app${
					appsToPlay.length === 1 ? "" : "s"
				} for ${chalk.green(String(idleMinutes))} minutes - for playtime`,
			);
		} else {
			this.log(
				`Idling ${chalk.green(String(appsToPlay.length))} app${
					appsToPlay.length === 1 ? "" : "s"
				} for ${chalk.green(String(idleMinutes))} minutes - ${chalk.green(String(totalDropsLeft))} card drop${
					totalDropsLeft === 1 ? "" : "s"
				} remaining across ${chalk.green(String(this.appsWithDrops.length))} app${
					this.appsWithDrops.length === 1 ? "" : "s"
				}`,
			);
		}

		clearTimeout(this.checkTimer);
		this.checkTimer = setTimeout(
			async () => {
				if (this.playStateBlocked) {
					this.log(chalk.red("Not cycling apps because you are playing a game elsewhere."));
					return;
				}

				for (const app of appsToPlay) {
					app.playtime += idleMinutes;
				}

				if (requiresIdling) {
					this.client.gamesPlayed([]);
				} else {
					await this.cycleApps(appids);
				}

				this.checkTimer = setTimeout(() => {
					if (this.appsWithDrops.length === 0) {
						this.log(chalk.green("No drops remaining, checking badges page again."));
						this.requestBadgesPage(1);
						return;
					}

					// background sync of badges every 3 hours
					if (Date.now() - this.lastBadgesCheck >= 1000 * 60 * 180) {
						this.requestBadgesPage(1, true);
					}

					this.idle();
				}, CYCLE_DELAY);
			},
			1000 * 60 * idleMinutes,
		);
	}

	getAppsToPlay(): GetAppsToPlayResult {
		let appsToPlay: AppWithDrops[] = [];
		let requiresIdling = false;
		const appsUnderMinPlaytime = this.appsWithDrops.filter(({ playtime }) => playtime < MIN_PLAYTIME_TO_IDLE);

		// if more than half of apps require idling, idle them
		if (appsUnderMinPlaytime.length > 0 && appsUnderMinPlaytime.length >= this.appsWithDrops.length / 2) {
			this.log(
				`${chalk.green(String(appsUnderMinPlaytime.length))} out of ${chalk.green(String(this.appsWithDrops.length))} apps require idling`,
			);

			// there's more than half of apps to idle, but not enough for the max, add some more
			if (appsUnderMinPlaytime.length < MAX_APPS_AT_ONCE) {
				const appsOverMinPlaytime = this.appsWithDrops.filter(
					({ playtime }) => playtime >= MIN_PLAYTIME_TO_IDLE,
				);
				appsOverMinPlaytime.sort((a, b) => a.playtime - b.playtime);

				// fill up apps to idle up to limit sorted by least playtime
				const appsToFill = arrayTakeFirst(appsOverMinPlaytime, MAX_APPS_AT_ONCE - appsUnderMinPlaytime.length);
				appsUnderMinPlaytime.push(...appsToFill);
			}

			requiresIdling = true;
			appsToPlay = appsUnderMinPlaytime;
		} else {
			appsToPlay = this.appsWithDrops;
		}

		appsToPlay.sort((a, b) => b.playtime - a.playtime);
		appsToPlay = arrayTakeFirst(appsToPlay, MAX_APPS_AT_ONCE);

		arrayShuffle(appsToPlay);

		return { requiresIdling, appsToPlay };
	}

	async cycleApps(appids: number[]): Promise<void> {
		this.log("Cycling apps...");

		let current = 1;

		do {
			await setTimeoutAsync(CYCLE_DELAY);

			if (this.playStateBlocked) {
				this.log(chalk.red("Not cycling apps because you are playing a game elsewhere."));
				return;
			}

			// quit apps one by one until the list is empty
			this.client.gamesPlayed(appids.slice(current));

			current += 1;
		} while (current <= appids.length);
	}

	onNotificationsReceived(payload: NotificationsPayload): void {
		const notificationIdsToRead: string[] = [];
		const newItems = payload.notifications.filter(
			// @ts-expect-error TS2339
			(notification) => notification.type === SteamUser.ESteamNotificationType.Item,
		);

		for (const notification of newItems) {
			if (notification.read || notification.viewed > 0) {
				continue;
			}

			const item = notification.body;

			if (!item || String(item.app_id) !== "753" || String(item.context_id) !== "6") {
				continue;
			}

			const itemSourceAppId = Number(item.source_appid);
			const appIndex = this.appsWithDrops.findIndex(({ appid }) => appid === itemSourceAppId);

			if (appIndex < 0) {
				this.log(
					`Got a drop for app ${chalk.green(itemSourceAppId.toString())}, but that is not an app we are idling - ${JSON.stringify(item)})`,
				);
				continue;
			}

			const app = this.appsWithDrops[appIndex];
			app.drops -= 1;

			this.log(
				`Got a drop for app ${chalk.green(itemSourceAppId.toString())}, drops remaining: ${chalk.green(app.drops.toString())}`,
			);

			if (app.drops < 1) {
				this.appsWithDrops.splice(appIndex, 1);
			}

			notificationIdsToRead.push(notification.id);
		}

		if (notificationIdsToRead.length > 0) {
			// @ts-expect-error TS2339
			this.client.markNotificationsRead(notificationIdsToRead);
		}
	}

	getPrivateApps(): void {
		const protobuf = ProtobufJS.Root.fromJSON(
			JSON.parse(readFileSync(resolvePath(dirname, "./protobuf_service_accountprivateapps.json"), "utf8")),
		);

		// @ts-expect-error TS2339
		this.client._send(
			{
				msg: 151, // EMsg.ServiceMethodCallFromClient
				proto: {
					target_job_name: "AccountPrivateApps.GetPrivateAppList#1",
				},
			},
			// @ts-expect-error TS2339
			protobuf.CAccountPrivateApps_GetPrivateAppList_Request.encode({}).finish(),
			// biome-ignore lint/suspicious/noExplicitAny: protobuf
			(body: any) => {
				// @ts-expect-error TS2339
				const response = SteamUser._decodeProto(protobuf.CAccountPrivateApps_GetPrivateAppList_Response, body);
				this.privateApps = new Set(response.private_apps.appids);

				if (this.privateApps.size > 0) {
					this.log(`You have ${this.privateApps.size} private apps`);
				}
			},
		);
	}

	onSteamGuard(domain: string | null, callback: (code: string) => void): void {
		enquirer
			.prompt<{ code: string }>([
				{
					type: "input",
					name: "code",
					message: domain ? `Steam guard code sent to ${domain}:` : "Steam app code:",
					validate: (input: string) => input.length === 5,
				},
			])
			.then((result) => callback(result.code))
			.catch(console.error);
	}

	async init(): Promise<void> {
		this.client.on("loggedOn", this.onLoggedIn.bind(this));
		this.client.on("refreshToken", this.onRefreshToken.bind(this));
		this.client.on("error", this.onError.bind(this));
		this.client.on("disconnected", this.onDisconnected.bind(this));
		this.client.on("playingState", this.onPlayingState.bind(this));
		this.client.on("webSession", this.onWebSession.bind(this));
		this.client.on("steamGuard", this.onSteamGuard.bind(this));
		// @ts-expect-error TS2339
		this.client.on("notificationsReceived", this.onNotificationsReceived.bind(this));

		process.on("SIGINT", () => {
			this.log("Logging off and shutting down...");
			this.shutdown(0);
		});

		let password = "";

		try {
			const args = arg({
				"--username": String,
				"--password": String,
				"--concurrent-apps": Number,
				"--min-playtime": Number,
				"--cycle-minutes": Number,
				"--cycle-delay": Number,

				"-u": "--username",
				"-p": "--password",
			});

			if (typeof args["--concurrent-apps"] !== "undefined") {
				MAX_APPS_AT_ONCE = args["--concurrent-apps"];

				if (MAX_APPS_AT_ONCE < 1 || MAX_APPS_AT_ONCE > 32) {
					throw new Error("--concurrent-apps out of range: must be between 1 and 32.");
				}
			}

			if (typeof args["--min-playtime"] !== "undefined") {
				MIN_PLAYTIME_TO_IDLE = args["--min-playtime"];

				if (MIN_PLAYTIME_TO_IDLE < 0) {
					throw new Error("--min-playtime must be positive.");
				}
			}

			if (typeof args["--cycle-minutes"] !== "undefined") {
				CYCLE_MINUTES_BETWEEN = args["--cycle-minutes"];

				if (CYCLE_MINUTES_BETWEEN < 0) {
					throw new Error("--cycle-minutes must be positive.");
				}
			}

			if (typeof args["--cycle-delay"] !== "undefined") {
				CYCLE_DELAY = args["--cycle-delay"];

				if (CYCLE_DELAY < 0) {
					throw new Error("--cycle-delay must be positive.");
				}
			}

			if (typeof args["--username"] === "string") {
				this.accountName = args["--username"].toLowerCase();
			}

			if (this.accountName && typeof args["--password"] === "string") {
				this.logOn(args["--password"]);
				return;
			}

			if (typeof args["--password"] === "string") {
				password = args["--password"];
			}
		} catch (e) {
			console.error((e as Error).message);
			process.exit(1);
			return;
		}

		const validate = (input: string): boolean => input.length > 0;

		if (!this.accountName) {
			const result = await enquirer.prompt<{ username: string }>({
				type: "input",
				name: "username",
				message: "Steam username:",
				validate,
			});
			this.accountName = result.username.toLowerCase();
		}

		const tokenFile = this.getRefreshTokenFilename();

		if (fileExists(tokenFile)) {
			const token = await readFile(tokenFile, "utf8");
			this.log("Logging in using saved refresh token...");
			this.logOn(null, token);
			return;
		}

		const result = await enquirer.prompt<{ password: string }>({
			type: "password",
			name: "password",
			message: "Steam password:",
			initial: password,
			validate,
		});
		this.logOn(result.password);
	}

	shutdown(code: number): void {
		this.client.gamesPlayed([]);
		this.client.logOff();
		this.client.once("disconnected", () => {
			process.exit(code);
		});

		setTimeout(() => {
			process.exit(code);
		}, 500);
	}

	getRefreshTokenFilename(): string {
		return resolvePath(this.dataDirectory, `./token.${this.accountName}.txt`);
	}

	log(message: string): void {
		const date = new Date();
		const isoDateTime = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
		const formatted = `[${isoDateTime.toISOString().split(".")[0].replace("T", " ")}]`;

		console.log(`${chalk.cyan(formatted)} ${message}`);
	}
}

const farmer = new SteamCardFarmer();
await farmer.init();
