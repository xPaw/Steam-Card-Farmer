#!/usr/bin/env node

import SteamUser from "steam-user";
import chalk from "ansi-colors";
import enquirer from "enquirer";
import { load as cheerio } from "cheerio";
import { promisify } from "util";
import { readFileSync } from "fs";
import { resolve as resolvePath } from "path";
import ProtobufJS from "protobufjs";
import arg from "arg";

const setTimeoutAsync = promisify(setTimeout);

// !!!
//
// "I receive a new item in my inventory" notification must be enabled
// https://store.steampowered.com/account/notificationsettings
//
// !!!

let MAX_APPS_AT_ONCE = 32; // how many apps to idle at once
let MIN_PLAYTIME_TO_IDLE = 180; // minimum playtime in minutes without cycling
let CYCLE_DELAY = 10000; // how many milliseconds to wait between cycling apps

/**
 * @param {Array} arr
 * @param {Number} end
 */
function arrayTakeFirst(arr, end) {
	const result = [];

	for (let i = 0; i < end && i < arr.length; i += 1) {
		result.push(arr[i]);
	}

	return result;
}

/**
 * @param {Array} array
 */
function arrayShuffle(array) {
	let currentIndex = array.length;

	while (currentIndex !== 0) {
		const randomIndex = Math.floor(Math.random() * currentIndex);
		currentIndex -= 1;

		// eslint-disable-next-line no-param-reassign
		[array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
	}
}

class SteamCardFarmer {
	/** @type {{appid: number, playtime: number, drops: number}[]} */
	appsWithDrops = [];

	/** @type {String[]} */
	cookies = [];

	checkTimer = null;

	playStateBlocked = false;

	lastBadgesCheck = Date.now();

	client = new SteamUser();

	/**
	 * @param {String} accountName
	 * @param {String} password
	 */
	logOn(accountName, password) {
		this.client.logOn({
			accountName,
			password,
			machineName: "Steam-Card-Farmer",
			logonID: 66666666,
		});
	}

	onLoggedIn() {
		this.log("Logged into Steam!");
	}

	/**
	 * @param {Error & ({eresult: SteamUser.EResult})} e
	 */
	onError(e) {
		clearTimeout(this.checkTimer);

		if (e.eresult === SteamUser.EResult.LoggedInElsewhere) {
			this.playStateBlocked = true;

			this.log(chalk.red("Another client logged in elsewhere."));

			setTimeout(() => this.client.logOn(true), 1000);

			return;
		}

		this.log(chalk.red(e.toString()));
	}

	/**
	 * @param {SteamUser.EResult} eResult
	 * @param {String} msg
	 */
	onDisconnected(eResult, msg) {
		clearTimeout(this.checkTimer);

		this.log(chalk.red(`Disconnected: ${msg}`));
	}

	/**
	 * @param {Boolean} blocked
	 */
	onPlayingState(blocked) {
		if (this.playStateBlocked === blocked) {
			return;
		}

		this.playStateBlocked = blocked;

		if (blocked) {
			this.log(chalk.red("Play state is blocked by another client."));
			clearTimeout(this.checkTimer);
			return;
		}

		this.log(chalk.green("Play state is no longer blocked."));
		this.idle();
	}

	/**
	 * @param {String} sessionID
	 * @param {String[]} cookies
	 */
	onWebSession(sessionID, cookies) {
		this.cookies = cookies;
		this.cookies.push("Steam_Language=english");

		clearTimeout(this.checkTimer);
		this.checkTimer = setTimeout(() => {
			this.log(`Web session received, checking badges...`);
			this.appsWithDrops = [];
			this.requestBadgesPage(1);
		}, 1000 * 2);
	}

	/**
	 * @param {Number} page
	 * @param {Boolean} syncOnly
	 */
	async requestBadgesPage(page, syncOnly = false) {
		let url = "";

		if (this.client.vanityURL) {
			url = `id/${this.client.vanityURL}`;
		} else {
			url = `profiles/${this.client.steamID.getSteamID64()}`;
		}

		let response;

		try {
			const headers = new Headers();
			headers.append("User-Agent", "Steam-Card-Farmer (+https://github.com/xPaw/Steam-Card-Farmer)");
			headers.append("Cookie", this.cookies.join("; "));

			response = await fetch(`https://steamcommunity.com/${url}/badges/?l=english&p=${page}`, {
				headers,
				redirect: "error",
				signal: AbortSignal.timeout(10000),
			});

			if (response.status !== 200) {
				throw new Error(`HTTP error ${response.status}`);
			}
		} catch (err) {
			this.log(chalk.red(`Page ${page}: failed to load: ${err}`));

			this.checkTimer = setTimeout(() => this.requestBadgesPage(page, syncOnly), 30000);
			return;
		}

		const text = await response.text();

		if (text.includes("g_steamID = false")) {
			this.log(chalk.red(`Page ${page}: loaded, but it is logged out`));
			this.client.webLogOn();
			return;
		}

		let pageDrops = 0;
		let pageApps = 0;
		const appIdToApp = new Map();
		const $ = cheerio(text);

		for (let i = 0; i < this.appsWithDrops.length; i += 1) {
			appIdToApp.set(this.appsWithDrops[i].appid, i);
		}

		$(".progress_info_bold").each((index, infoline) => {
			const match = $(infoline).text().match(/(\d+)/);

			if (!match) {
				return;
			}

			const row = $(infoline).closest(".badge_row");
			const href = row.find(".badge_title_playgame a").attr("href");

			if (!href) {
				return;
			}

			const urlparts = href.split("/");
			const appid = parseInt(urlparts[urlparts.length - 1], 10) || 0;
			const drops = parseInt(match[1], 10) || 0;

			if (appid < 1 || drops < 1) {
				return;
			}

			pageDrops += drops;
			pageApps += 1;

			let playtime = 0.0;
			const playTimeMatch = row
				.find(".badge_title_stats_playtime")
				.text()
				.match(/(?<playtime>\d+\.\d+)/);

			if (playTimeMatch) {
				playtime = parseFloat(playTimeMatch.groups.playtime) || 0.0;
				playtime = Math.round(playtime * 60);
			}

			const app = {
				appid,
				playtime,
				drops,
			};

			const existingAppIndex = appIdToApp.get(appid);

			if (typeof existingAppIndex !== "undefined") {
				const existingApp = this.appsWithDrops[existingAppIndex];
				existingApp.drops = drops;
				existingApp.playtime = playtime;
				return;
			}

			this.appsWithDrops.push(app);
			appIdToApp.set(appid, app);
		});

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

		const lastPage = parseInt($(".pagelink").last().text(), 10) || 1;

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

	idle() {
		if (this.playStateBlocked) {
			this.log(chalk.red("Play state is blocked, unable to idle."));
			return;
		}

		const totalDropsLeft = this.appsWithDrops.reduce((total, { drops }) => total + drops, 0);

		const temp = this.getAppsToPlay();
		let { requiresIdling } = temp;
		const { appsToPlay } = temp;
		const appids = appsToPlay.map(({ appid }) => appid);

		this.client.gamesPlayed(appids);

		let idleMinutes = 5;

		if (requiresIdling) {
			// take the median time until minimum playtime is reached and then check again
			const medianPlaytime = appsToPlay[Math.floor(appsToPlay.length / 2)];
			idleMinutes = MIN_PLAYTIME_TO_IDLE - medianPlaytime.playtime;

			if (idleMinutes < 5) {
				requiresIdling = false;
				idleMinutes = 5;
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

		this.checkTimer = setTimeout(
			async () => {
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

	getAppsToPlay() {
		let requiresIdling = false;
		let appsToPlay = [];
		const appsUnderMinPlaytime = this.appsWithDrops.filter(({ playtime }) => playtime < MIN_PLAYTIME_TO_IDLE);

		// if more than half of apps require idling, idle them
		if (appsUnderMinPlaytime.length >= this.appsWithDrops.length / 2) {
			this.log(
				`${chalk.green(String(appsUnderMinPlaytime.length))} out of ${chalk.green(String(this.appsWithDrops.length))} apps require idling`,
			);

			// there's more than half of apps to idle, but not enough for the max, add some more
			if (appsUnderMinPlaytime.length < MAX_APPS_AT_ONCE) {
				const appsOverMinPlaytime = this.appsWithDrops.filter(({ playtime }) => playtime >= MIN_PLAYTIME_TO_IDLE);
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

	/**
	 * @param {Number[]} appids
	 */
	async cycleApps(appids) {
		this.log("Cycling apps...");

		let current = 1;

		do {
			await setTimeoutAsync(CYCLE_DELAY);

			if (this.playStateBlocked) {
				this.log(chalk.red("Play state got blocked while cycling."));
				return;
			}

			// quit apps one by one until the list is empty
			this.client.gamesPlayed(appids.slice(current));

			current += 1;
		} while (current <= appids.length);
	}

	/**
	 * @param {String} domain
	 * @param {Function} callback
	 */
	// eslint-disable-next-line class-methods-use-this
	onSteamGuard(domain, callback) {
		enquirer
			.prompt([
				{
					type: "input",
					name: "code",
					message: domain ? `Steam guard code sent to ${domain}:` : "Steam app code:",
					validate: (input) => input.length === 5,
				},
			])
			.then((/** @type {{code: String}} */ result) => callback(result.code))
			.catch(console.error); // eslint-disable-line no-console
	}

	init() {
		this.client.on("loggedOn", () => this.onLoggedIn.bind(this));
		this.client.on("error", this.onError.bind(this));
		this.client.on("disconnected", this.onDisconnected.bind(this));
		this.client.on("playingState", this.onPlayingState.bind(this));
		this.client.on("webSession", this.onWebSession.bind(this));
		this.client.on("steamGuard", this.onSteamGuard.bind(this));
		this.handleNotifications();

		process.on("SIGINT", () => {
			this.log("Logging off and shutting down...");
			this.shutdown(0);
		});

		let args;

		try {
			args = arg({
				"--username": String,
				"--password": String,
				"--concurrent-apps": Number,
				"--min-playtime": Number,
				"--cycle-delay": Number,

				"-u": "--username",
				"-p": "--password",
			});

			if (typeof args["--concurrent-apps"] !== "undefined") {
				MAX_APPS_AT_ONCE = args["--concurrent-apps"];

				if (MAX_APPS_AT_ONCE < 1 || MAX_APPS_AT_ONCE) {
					throw new Error("--concurrent-apps out of range");
				}
			}

			if (typeof args["--min-playtime"] !== "undefined") {
				MIN_PLAYTIME_TO_IDLE = args["--min-playtime"];
			}

			if (typeof args["--cycle-delay"] !== "undefined") {
				CYCLE_DELAY = args["--cycle-delay"];
			}
		} catch (e) {
			console.error(e.message); // eslint-disable-line no-console
			process.exit(1);
			return;
		}

		if (args["--username"] && args["--password"]) {
			this.logOn(args["--username"], args["--password"]);
			return;
		}

		const validate = (/** @type string */ input) => input.length > 0;

		enquirer
			.prompt([
				{
					type: "input",
					name: "username",
					message: "Steam username:",
					initial: args["--username"] || "",
					validate,
				},
				{
					type: "password",
					name: "password",
					message: "Steam password:",
					initial: args["--password"] || "",
					validate,
				},
			])
			.then((/** @type {{username: String, password: String}} */ result) =>
				this.logOn(result.username, result.password),
			)
			.catch(console.error); // eslint-disable-line no-console
	}

	handleNotifications() {
		const { dirname } = import.meta;

		const protobuf = ProtobufJS.Root.fromJSON(
			JSON.parse(readFileSync(resolvePath(dirname, "./protobuf_steamnotifications.json"), "utf8")),
		);
		const protobufRead = ProtobufJS.Root.fromJSON(
			JSON.parse(readFileSync(resolvePath(dirname, "./protobuf_steamnotification_read.json"), "utf8")),
		);

		/* eslint-disable no-underscore-dangle */
		this.client._handlerManager.add("SteamNotificationClient.NotificationsReceived#1", (body) => {
			const notifications = SteamUser._decodeProto(
				protobuf.CSteamNotification_NotificationsReceived_Notification,
				body,
			);

			const notificationIdsToRead = [];
			const newItems = notifications.notifications.filter(
				(notification) =>
					notification.notification_type === protobuf.ESteamNotificationType.k_ESteamNotificationType_Item,
			);

			for (const notification of newItems) {
				if (notification.read || notification.viewed > 0) {
					continue;
				}

				const item = JSON.parse(notification.body_data);

				// eslint-disable-next-line eqeqeq
				if (!item || item.app_id != 753 || item.context_id != 6) {
					continue;
				}

				const itemSourceAppId = item.source_appid;
				const appIndex = this.appsWithDrops.findIndex(({ appid }) => appid === itemSourceAppId);

				if (appIndex < 0) {
					this.log(
						`Got item drop for app ${itemSourceAppId}, but that is not an app we are idling - ${notification.body_data})`,
					);
					continue;
				}

				const app = this.appsWithDrops[appIndex];
				app.drops -= 1;
				this.log(`Got an item drop for app ${itemSourceAppId}, drops remaining: ${app.drops}`);

				if (app.drops < 1) {
					this.appsWithDrops.splice(appIndex, 1);
				}

				notificationIdsToRead.push(notification.notification_id);
			}

			if (notificationIdsToRead.length > 0) {
				this.client._send(
					{
						msg: 151, // EMsg.ServiceMethodCallFromClient
						proto: {
							target_job_name: "SteamNotification.MarkNotificationsRead#1",
						},
					},
					protobufRead.CSteamNotification_MarkNotificationsRead_Notification.encode({
						notification_ids: notificationIdsToRead,
					}).finish(),
				);
			}
		});
	}

	/**
	 * @param {Number} code
	 */
	shutdown(code) {
		this.client.gamesPlayed([]);
		this.client.logOff();
		this.client.once("disconnected", () => {
			process.exit(code);
		});

		setTimeout(() => {
			process.exit(code);
		}, 500);
	}

	/**
	 * @param {String} message
	 */
	// eslint-disable-next-line class-methods-use-this
	log(message) {
		const date = new Date();
		const isoDateTime = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
		const formatted = `[${isoDateTime.toISOString().split(".")[0].replace("T", " ")}]`;

		// eslint-disable-next-line no-console
		console.log(`${chalk.cyan(formatted)} ${message}`);
	}
}

const farmer = new SteamCardFarmer();
farmer.init();
