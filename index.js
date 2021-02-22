#!/usr/bin/env node

const chalk = require('chalk');
const cheerio = require('cheerio');
const got = require('got');
const inquirer = require('inquirer');
const SteamUser = require('steam-user');
const tough = require('tough-cookie');

class SteamCardFarmer {
	constructor() {
		this.page = 1;
		this.checkTimer = null;
		this.requestInFlight = false;
		this.playStateBlocked = false;
		this.resetToFirstPage = false;

		this.cookieJar = new tough.CookieJar();
		this.cookieJar.setCookie('Steam_Language=english', 'https://steamcommunity.com');

		this.client = new SteamUser({
			protocol: SteamUser.EConnectionProtocol.TCP,
		});
		this.client.on('loggedOn', () => this.log('Logged into Steam!'));
		this.client.on('error', this.onError.bind(this));
		this.client.on('disconnected', this.onDisconnected.bind(this));
		this.client.on('playingState', this.onPlayingState.bind(this));
		this.client.on('newItems', this.onNewItems.bind(this));
		this.client.on('webSession', this.onWebSession.bind(this));
		this.client.on('steamGuard', this.onSteamGuard.bind(this));
	}

	logOn(accountName, password) {
		this.client.logOn({
			accountName,
			password,
			rememberPassword: true,
			machineName: 'Steam-Card-Farmer',
			logonID: 66666666,
		});
	}

	onError(e) {
		clearTimeout(this.checkTimer);

		if (e.eresult === SteamUser.EResult.LoggedInElsewhere) {
			this.playStateBlocked = true;

			this.log(chalk.red('Another client logged in elsewhere.'));

			setTimeout(() => this.client.logOn(true), 1000);

			return;
		}

		this.log(chalk.red(e));
	}

	onDisconnected(eResult, msg) {
		clearTimeout(this.checkTimer);

		this.log(chalk.red(`Disconnected: ${msg}`));
	}

	onPlayingState(blocked) {
		if (this.playStateBlocked === blocked) {
			return;
		}

		this.playStateBlocked = blocked;

		if (blocked) {
			clearTimeout(this.checkTimer);
			return;
		}

		this.log(chalk.green('Play state is no longer blocked.'));
		this.checkCardsInSeconds(1);
	}

	onNewItems(count) {
		if (count === 0) {
			return;
		}

		this.log(chalk.green(`Got notification of new inventory items: ${count} new item${count === 1 ? '' : 's'}`));
		this.checkCardsInSeconds(2);
	}

	onWebSession(sessionID, cookies) {
		cookies.forEach((cookie) => {
			this.cookieJar.setCookie(cookie, 'https://steamcommunity.com');
		});

		this.requestBadgesPage();
	}

	async requestBadgesPage() {
		if (this.requestInFlight || this.playStateBlocked) {
			return;
		}

		this.requestInFlight = true;

		this.log(`Checking card drops on page ${this.page}...`);

		let url = '';

		if (this.client.vanityURL) {
			url = `id/${this.client.vanityURL}`;
		} else {
			url = `profiles/${this.client.steamID.getSteamID64()}`;
		}

		let response;

		try {
			response = await got({
				url: `https://steamcommunity.com/${url}/badges/?l=english&p=${this.page}`,
				followRedirect: false,
				timeout: 10000,
				cookieJar: this.cookieJar,
			});

			if (response.statusCode !== 200) {
				throw new Error(`HTTP error ${response.statusCode}`);
			}
		} catch (err) {
			this.log(chalk.red(`Couldn't request badge page: ${err}`));
			this.checkCardsInSeconds(30);
			return;
		} finally {
			this.requestInFlight = false;
		}

		if (response.body.includes('g_steamID = false')) {
			this.log(chalk.red('Badge page loaded, but its logged out'));
			this.client.webLogOn();
			return;
		}

		let appsWithDrops = [];
		let totalDropsLeft = 0;
		let totalApps = 0;
		const $ = cheerio.load(response.body);

		$('.progress_info_bold').each((index, infoline) => {
			const match = $(infoline).text().match(/(\d+)/);

			if (!match) {
				return;
			}

			const row = $(infoline).closest('.badge_row');
			const href = row.find('.badge_title_playgame a').attr('href');

			if (!href) {
				return;
			}

			const urlparts = href.split('/');
			const appid = parseInt(urlparts[urlparts.length - 1], 10) || 0;
			const drops = parseInt(match[1], 10) || 0;

			if (appid < 1 || drops < 1) {
				return;
			}

			totalDropsLeft += drops;
			totalApps += 1;

			let playtime = parseFloat(row.find('.badge_title_stats_playtime').text().match(/(\d+\.\d+)/), 10) || 0.0;
			playtime = Math.round(playtime * 60);

			const appObj = {
				appid,
				playtime,
				drops,
			};

			appsWithDrops.push(appObj);
		});

		const MAX_APPS_AT_ONCE = 32;

		if (totalDropsLeft > 0) {
			this.resetToFirstPage = true;

			this.log(`${chalk.green(totalDropsLeft)} card drop${
				totalDropsLeft === 1 ? '' : 's'
			} remaining across ${chalk.green(totalApps)} app${
				totalApps === 1 ? '' : 's'
			} on page ${this.page}`);

			if (appsWithDrops.length > MAX_APPS_AT_ONCE) {
				appsWithDrops.sort((a, b) => b.playtime - a.playtime);
				appsWithDrops = appsWithDrops.slice(0, MAX_APPS_AT_ONCE);
			}

			this.client.gamesPlayed(appsWithDrops.map(({ appid }) => appid));

			this.checkCardsInSeconds(5 * 60, this.quitPlaying.bind(this));
		} else if (this.page <= (parseInt($('.pagelink').last().text(), 10) || 1)) {
			this.log(chalk.green(`No drops remaining on page ${this.page}`));
			this.page += 1;
			this.log(`Checking page ${this.page}...`);
			this.checkCardsInSeconds(1);
		} else if (this.page > 1 && this.resetToFirstPage) {
			this.log(chalk.green('All pages checked, resetting to page 1 and checking again'));
			this.resetToFirstPage = false;
			this.page = 1;
			this.checkCardsInSeconds(1);
		} else {
			this.log(chalk.green('All card drops received!'));
			this.shutdown(0);
		}
	}

	quitPlaying() {
		this.client.gamesPlayed([]);
	}

	checkCardsInSeconds(seconds, callback) {
		clearTimeout(this.checkTimer);

		if (this.playStateBlocked) {
			return;
		}

		this.checkTimer = setTimeout(() => {
			if (callback) {
				callback();
			}

			this.requestBadgesPage();
		}, 1000 * seconds);
	}

	// eslint-disable-next-line class-methods-use-this
	onSteamGuard(domain, callback) {
		inquirer
			.prompt([
				{
					type: 'input',
					name: 'code',
					message: domain ? `Steam guard code sent to ${domain}:` : 'Steam app code:',
					validate: (input) => input.length === 5,
				},
			])
			.then((result) => callback(result.code));
	}

	init() {
		process.on('SIGINT', () => {
			this.log('Logging off and shutting down...');
			this.shutdown(0);
		});

		let argsStartIdx = 2;
		if (process.argv[0] === 'steamcardfarmer') {
			argsStartIdx = 1;
		}

		if (process.argv.length === argsStartIdx + 2) {
			this.logOn(process.argv[argsStartIdx], process.argv[argsStartIdx + 1]);
			return;
		}

		const validate = (input) => input.length > 0;

		inquirer
			.prompt([
				{
					type: 'input',
					name: 'username',
					message: 'Steam username:',
					validate,
				},
				{
					type: 'password',
					name: 'password',
					message: 'Steam password:',
					mask: '*',
					validate,
				},
			])
			.then((result) => this.logOn(result.username, result.password));
	}

	shutdown(code) {
		this.client.logOff();
		this.client.once('disconnected', () => {
			process.exit(code);
		});

		setTimeout(() => {
			process.exit(code);
		}, 500);
	}

	// eslint-disable-next-line class-methods-use-this
	log(message) {
		const date = new Date();
		const isoDateTime = new Date(date.getTime() - (date.getTimezoneOffset() * 60000));
		const formatted = `[${isoDateTime.toISOString().split('.')[0].replace('T', ' ')}]`;

		// eslint-disable-next-line no-console
		console.log(`${chalk.cyan(formatted)} ${message}`);
	}
}

const farmer = new SteamCardFarmer();
farmer.init();
