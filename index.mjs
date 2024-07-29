#!/usr/bin/env node

import SteamUser from "steam-user";
import chalk from "ansi-colors";
import enquirer from "enquirer";
import { load as cheerio } from "cheerio";
import { promisify } from "util";

const setTimeoutAsync = promisify(setTimeout);

const MAX_APPS_AT_ONCE = 32; // how many apps to idle at once
const MIN_PLAYTIME_TO_IDLE = 180; // minimum playtime in minutes without cycling
const CYCLE_DELAY = 1000; // how many milliseconds to wait between cycling apps

class SteamCardFarmer {
	page = 1;

	checkTimer = null;

	requestInFlight = false;

	playStateBlocked = false;

	resetToFirstPage = false;

	idling = false;

	/** @type {String[]} */
	cookies = [];

	client = new SteamUser({
		protocol: SteamUser.EConnectionProtocol.TCP,
	});

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
		this.idling = false;
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
		this.checkCardsInSeconds(30);
	}

	/**
	 * @param {Number} count
	 */
	onNewItems(count) {
		if (count === 0) {
			return;
		}

		this.log(chalk.green(`Got notification of new inventory items: ${count} new item${count === 1 ? "" : "s"}`));

		if (this.idling) {
			this.checkCardsInSeconds(2);
		}
	}

	/**
	 * @param {String} sessionID
	 * @param {String[]} cookies
	 */
	onWebSession(sessionID, cookies) {
		this.cookies = cookies;
		this.cookies.push("Steam_Language=english");

		this.checkCardsInSeconds(2);
	}

	async requestBadgesPage() {
		if (this.requestInFlight || this.playStateBlocked) {
			return;
		}

		this.requestInFlight = true;

		this.log(`Checking card drops on page ${this.page}...`);

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

			response = await fetch(`https://steamcommunity.com/${url}/badges/?l=english&p=${this.page}`, {
				headers,
				redirect: "error",
				signal: AbortSignal.timeout(10000),
			});

			if (response.status !== 200) {
				throw new Error(`HTTP error ${response.status}`);
			}
		} catch (err) {
			this.log(chalk.red(`Couldn't request badge page: ${err}`));
			this.checkCardsInSeconds(30);
			return;
		} finally {
			this.requestInFlight = false;
		}

		const text = await response.text();

		if (text.includes("g_steamID = false")) {
			this.log(chalk.red("Badge page loaded, but it is logged out."));
			this.client.webLogOn();
			return;
		}

		if (this.playStateBlocked) {
			this.log(chalk.red("Play state got blocked while loading badge page."));
			return;
		}

		/** @type {{appid: number, playtime: number, drops: number}[]} */
		const appsWithDrops = [];
		let totalDropsLeft = 0;
		const $ = cheerio(text);

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

			totalDropsLeft += drops;

			let playtime = 0.0;
			const playTimeMatch = row
				.find(".badge_title_stats_playtime")
				.text()
				.match(/(?<playtime>\d+\.\d+)/);

			if (playTimeMatch) {
				playtime = parseFloat(playTimeMatch.groups.playtime) || 0.0;
				playtime = Math.round(playtime * 60);
			}

			const appObj = {
				appid,
				playtime,
				drops,
			};

			appsWithDrops.push(appObj);
		});

		if (totalDropsLeft > 0) {
			this.resetToFirstPage = true;

			this.log(
				`${chalk.green(String(totalDropsLeft))} card drop${
					totalDropsLeft === 1 ? "" : "s"
				} remaining across ${chalk.green(String(appsWithDrops.length))} app${
					appsWithDrops.length === 1 ? "" : "s"
				} on page ${this.page}`,
			);

			const { requiresIdling, appsToPlay } = this.getAppsToPlay(appsWithDrops);
			const appids = appsToPlay.map(({ appid }) => appid);

			this.idling = true;
			this.client.gamesPlayed(appids);

			if (requiresIdling) {
				// take the median time until minimum playtime is reached and then check the badges again
				const medianPlaytime = appsToPlay[Math.floor(appsToPlay.length / 2)];

				// have to idle for at least 6 minutes because of rounded hours on badges page
				const idleTime = Math.max(6, MIN_PLAYTIME_TO_IDLE - medianPlaytime.playtime);

				this.log(`Idling ${chalk.green(String(appsToPlay.length))} apps for ${chalk.green(String(idleTime))} minutes`);

				this.checkTimer = setTimeout(
					async () => {
						this.idling = false;

						this.client.gamesPlayed([]);

						this.checkCardsInSeconds(1);
					},
					1000 * 60 * idleTime,
				);

				return;
			}

			// cycle all apps one by one after 5 minutes of idling them all
			this.checkTimer = setTimeout(
				async () => {
					this.idling = false;

					await this.cycleApps(appids);

					this.checkCardsInSeconds(0);
				},
				1000 * 60 * 5,
			);
		} else if (this.page <= (parseInt($(".pagelink").last().text(), 10) || 1)) {
			this.log(chalk.green(`No drops remaining on page ${this.page}`));
			this.page += 1;
			this.log(`Checking page ${this.page}...`);
			this.checkCardsInSeconds(0);
		} else if (this.page > 1 && this.resetToFirstPage) {
			this.log(chalk.green("All pages checked, resetting to page 1 and checking again"));
			this.resetToFirstPage = false;
			this.page = 1;
			this.checkCardsInSeconds(0);
		} else {
			this.log(chalk.green("All card drops received!"));
			this.shutdown(0);
		}
	}

	/**
	 * @param {{appid: number, playtime: number, drops: number}[]} appsWithDrops
	 */
	getAppsToPlay(appsWithDrops) {
		let requiresIdling = false;
		let appsToPlay = appsWithDrops;
		const appsUnderMinPlaytime = appsToPlay.filter(({ playtime }) => playtime < MIN_PLAYTIME_TO_IDLE);

		// if more than half of apps require idling, idle them
		if (appsUnderMinPlaytime.length >= appsToPlay.length / 2) {
			this.log(
				`${chalk.green(String(appsUnderMinPlaytime.length))} out of ${chalk.green(String(appsToPlay.length))} apps require idling`,
			);

			// there's more than half of apps to idle, but not enough for the max, add some more
			if (appsUnderMinPlaytime.length < MAX_APPS_AT_ONCE) {
				const appsOverMinPlaytime = appsToPlay.filter(({ playtime }) => playtime >= MIN_PLAYTIME_TO_IDLE);
				appsOverMinPlaytime.sort((a, b) => a.playtime - b.playtime);

				// fill up apps to idle up to limit sorted by least playtime
				const appsToFill = appsOverMinPlaytime.slice(0, MAX_APPS_AT_ONCE - appsUnderMinPlaytime.length);
				appsUnderMinPlaytime.push(...appsToFill);
			}

			requiresIdling = true;
			appsToPlay = appsUnderMinPlaytime;
		}

		appsToPlay.sort((a, b) => b.playtime - a.playtime);
		appsToPlay = appsToPlay.slice(0, MAX_APPS_AT_ONCE);

		return { requiresIdling, appsToPlay };
	}

	/**
	 * @param {Number[]} appids
	 */
	async cycleApps(appids) {
		this.log("Cycling apps...");

		this.client.gamesPlayed([]);

		let current = 0;

		do {
			await setTimeoutAsync(CYCLE_DELAY); // eslint-disable-line no-await-in-loop

			if (this.playStateBlocked) {
				this.log(chalk.red("Play state got blocked while cycling."));
				return;
			}

			this.client.gamesPlayed(appids[current]);

			await setTimeoutAsync(CYCLE_DELAY); // eslint-disable-line no-await-in-loop

			this.client.gamesPlayed([]);

			current += 1;
		} while (current < appids.length);
	}

	/**
	 * @param {Number} seconds
	 */
	checkCardsInSeconds(seconds) {
		clearTimeout(this.checkTimer);

		if (this.playStateBlocked) {
			return;
		}

		this.checkTimer = setTimeout(() => {
			this.requestBadgesPage();
		}, 1000 * seconds);
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
		this.client.on("newItems", this.onNewItems.bind(this));
		this.client.on("webSession", this.onWebSession.bind(this));
		this.client.on("steamGuard", this.onSteamGuard.bind(this));

		process.on("SIGINT", () => {
			this.log("Logging off and shutting down...");
			this.shutdown(0);
		});

		let argsStartIdx = 2;
		if (process.argv[0] === "steamcardfarmer") {
			argsStartIdx = 1;
		}

		if (process.argv.length === argsStartIdx + 2) {
			this.logOn(process.argv[argsStartIdx], process.argv[argsStartIdx + 1]);
			return;
		}

		const validate = (/** @type string */ input) => input.length > 0;

		enquirer
			.prompt([
				{
					type: "input",
					name: "username",
					message: "Steam username:",
					validate,
				},
				{
					type: "password",
					name: "password",
					message: "Steam password:",
					validate,
				},
			])
			.then((/** @type {{username: String, password: String}} */ result) =>
				this.logOn(result.username, result.password),
			)
			.catch(console.error); // eslint-disable-line no-console
	}

	/**
	 * @param {Number} code
	 */
	shutdown(code) {
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
