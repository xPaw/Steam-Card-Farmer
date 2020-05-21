#!/usr/bin/env node

const SteamUser = require('steam-user');
const prompt = require('prompt');
const chalk = require('chalk');
const Cheerio = require('cheerio');
const got = require('got');
const tough = require('tough-cookie');

class SteamCardFarmer {
	constructor() {
		this.client = new SteamUser({
			protocol: SteamUser.EConnectionProtocol.TCP,
		});

		this.cookieJar = new tough.CookieJar();
		this.cookieJar.setCookie('Steam_Language=english', 'https://steamcommunity.com');

		this.page = 1;
		this.checkTimer = null;
		this.requestInFlight = false;
		this.playStateBlocked = false;
	}

	logOn(username, password) {
		this.client.logOn({
			accountName: username,
			password,
			rememberPassword: true,
			machineName: 'Steam-Card-Farmer',
			logonID: 66666666,
		});

		this.client.on('loggedOn', () => {
			this.log('Logged into Steam!');
		});

		this.client.on('error', (e) => {
			clearTimeout(this.checkTimer);

			if (e.eresult === SteamUser.EResult.LoggedInElsewhere) {
				this.playStateBlocked = true;

				this.log(chalk.red('Another client logged in elsewhere, re-logging in...'));

				setTimeout(() => this.client.logOn(true), 1000);

				return;
			}

			this.log(chalk.red(`Error: ${e}`));
		});

		this.client.on('disconnected', (eResult, msg) => {
			this.log(chalk.red(`Disconnected: Eresult.${eResult} - ${msg}`));
			clearTimeout(this.checkTimer);
		});

		this.client.on('playingState', (blocked, playingApp) => {
			if (this.playStateBlocked === blocked) {
				return;
			}

			this.playStateBlocked = blocked;

			if (blocked) {
				this.log(chalk.yellowBright(`App ${playingApp} was launched on another client, no longer idling.`));
				clearTimeout(this.checkTimer);
			} else {
				this.log(chalk.yellowBright('Play state is no longer blocked.'));
				this.checkCardsInSeconds(1);
			}
		});

		this.client.on('newItems', (count) => {
			if (count === 0) {
				return;
			}

			this.log(chalk.yellowBright(`Got notification of new inventory items: ${count} new item${count === 1 ? '' : 's'}`));
			this.checkCardsInSeconds(1);
		});

		this.client.on('webSession', async (sessionID, cookies) => {
			if (this.playStateBlocked) {
				this.log(chalk.red('Got a web session, but play state is blocked.'));
				return;
			}

			if (this.requestInFlight) {
				this.log(chalk.red('Got a web session, but a request is already in flight.'));
				return;
			}

			this.requestInFlight = true;

			this.log('Got a web session, checking card drops...');

			cookies.forEach((cookie) => {
				this.cookieJar.setCookie(cookie, 'https://steamcommunity.com');
			});

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
			} catch (err) {
				this.log(chalk.red(`Couldn't request badge page: ${err}`));
				this.checkCardsInSeconds(30);
				this.requestInFlight = false;
				return;
			}

			this.requestInFlight = false;

			if (response.statusCode !== 200) {
				this.log(chalk.red(`Couldn't request badge page: HTTP error ${response.statusCode}`));
				this.checkCardsInSeconds(30);
				return;
			}

			if (response.body.includes('g_steamID = false')) {
				this.log(chalk.red('Badge page loaded, but its logged out'));
				this.checkCardsInSeconds(30);
				return;
			}

			let lowHourApps = [];
			const hasDropsApps = [];

			const $ = Cheerio.load(response.body);

			$('.progress_info_bold').each((index, infoline) => {
				const match = $(infoline).text().match(/(\d+)/);
				const row = $(infoline).closest('.badge_row');
				const href = row.find('.badge_title_playgame a').attr('href');

				if (!match || !href) {
					return;
				}

				const urlparts = href.split('/');
				const appid = parseInt(urlparts[urlparts.length - 1], 10) || 0;
				const drops = parseInt(match[1], 10) || 0;

				if (appid < 1 || drops < 1) {
					return;
				}

				let title = row.find('.badge_title');
				title.find('.badge_view_details').remove();
				title = title.text().trim();

				let playtime = parseFloat(row.find('.badge_title_stats').html().match(/(\d+\.\d+)/), 10) || 0.0;
				playtime = Math.round(playtime * 60);

				const appObj = {
					appid,
					title,
					playtime,
					drops,
				};

				if (playtime < 120) {
					lowHourApps.push(appObj);
				} else {
					hasDropsApps.push(appObj);
				}
			});

			if (lowHourApps.length > hasDropsApps.length) {
				let minPlaytime = 120;

				lowHourApps = lowHourApps.slice(0, 32);
				lowHourApps.forEach((app) => {
					if (app.playtime < minPlaytime) {
						minPlaytime = app.playtime;
					}

					this.log(`App ${app.appid} - ${chalk.green(app.title)} - Playtime: ${chalk.green(app.playtime)} min`);
				});

				minPlaytime = 120 - minPlaytime;

				this.log(
					`Idling ${chalk.green(lowHourApps.length)} app${lowHourApps.length === 1 ? '' : 's'}`
				+ ` up to 2 hours. This will take ${chalk.green(minPlaytime)} minutes.`,
				);

				this.client.gamesPlayed(lowHourApps.map((app) => app.appid));

				this.checkCardsInSeconds(60 * minPlaytime, () => {
					this.log('Stopped idling previous apps.');
					this.client.gamesPlayed([]);
				});
			} else if (hasDropsApps.length > 0) {
				const totalDropsLeft = hasDropsApps.reduce((sum, { drops }) => sum + drops, 0);
				const appToIdle = hasDropsApps[0];

				this.log(
					`${chalk.green(totalDropsLeft)} card drop${totalDropsLeft === 1 ? '' : 's'}`
				+ ` remaining across ${chalk.green(hasDropsApps.length)} app${hasDropsApps.length === 1 ? '' : 's'}`
				+ ` ${chalk.cyan(`(page ${this.page})`)}`,
				);

				this.log(
					`Idling app ${appToIdle.appid} "${chalk.green(appToIdle.title)}" - `
				+ `${chalk.green(appToIdle.drops)} drop${appToIdle.drops === 1 ? '' : 's'} remaining.`,
				);

				this.client.gamesPlayed(appToIdle.appid);

				// 20 minutes to be safe, we should automatically check when
				// Steam notifies us that we got a new item anyway
				this.checkCardsInSeconds(1200);
			} else if (this.page <= (parseInt($('.pagelink').last().text(), 10) || 1)) {
				this.log(chalk.green(`No drops remaining on page ${this.page}`));
				this.page += 1;
				this.log(`Checking page ${this.page}...`);
				this.checkCardsInSeconds(1);
			} else {
				this.log(chalk.green('All card drops received! Shutting down...'));
				this.shutdown(0);
			}
		});
	}

	checkCardsInSeconds(seconds, callback) {
		if (this.checkTimer) {
			clearTimeout(this.checkTimer);
		}

		this.checkTimer = setTimeout(() => {
			if (callback) {
				callback();
			}

			this.checkCardApps();
		}, 1000 * seconds);
	}

	checkCardApps() {
		if (this.requestInFlight) {
			this.log(chalk.red('Wanted to request a web session, but a request is already in flight.'));
			return;
		}

		this.log('Requesting a web session...');

		this.client.webLogOn();
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
		console.log(`${chalk.cyan(formatted)} ${message}`);
	}
}

function performLogon() {
	const farmer = new SteamCardFarmer();

	process.on('SIGINT', () => {
		farmer.log('Logging off and shutting down...');
		farmer.shutdown(0);
	});

	let argsStartIdx = 2;
	if (process.argv[0] === 'steamcardfarmer') {
		argsStartIdx = 1;
	}

	if (process.argv.length === argsStartIdx + 2) {
		farmer(process.argv[argsStartIdx], process.argv[argsStartIdx + 1]);
	} else {
		prompt.start();
		prompt.get({
			properties: {
				username: {
					type: 'string',
					required: true,
				},
				password: {
					type: 'string',
					hidden: true,
					replace: '*',
					required: true,
				},
			},
		}, (err, result) => {
			if (err) {
				farmer.log(`Error: ${err}`);
				farmer.shutdown(1);
				return;
			}

			farmer.logOn(result.username, result.password);
		});
	}
}

performLogon();
