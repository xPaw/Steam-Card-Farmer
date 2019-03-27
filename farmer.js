#!/usr/bin/env node

const SteamUser = require('steam-user');
const prompt = require('prompt');
const chalk = require('chalk');
const Cheerio = require('cheerio');

const client = new SteamUser();

let request = require('request');

const g_Jar = request.jar();
request = request.defaults({ jar: g_Jar });

let g_Page = 1;
let g_CheckTimer;
let g_RequestInFlight = false;

function log(message) {
	const date = new Date();
	const time = [
		date.getFullYear(),
		date.getMonth() + 1,
		date.getDate(),
		date.getHours(),
		date.getMinutes(),
		date.getSeconds(),
	];

	for (let i = 1; i < 6; i += 1) {
		if (time[i] < 10) {
			time[i] = `0${time[i]}`;
		}
	}

	const formatted = `[${time[0]}-${time[1]}-${time[2]} ${time[3]}:${time[4]}:${time[5]}]`;

	console.log(`${chalk.cyan(formatted)} ${message}`);
}

function shutdown(code) {
	client.logOff();
	client.once('disconnected', () => {
		process.exit(code);
	});

	setTimeout(() => {
		process.exit(code);
	}, 500);
}

function checkCardsInSeconds(seconds, callback) {
	if (g_CheckTimer) {
		clearTimeout(g_CheckTimer);
	}

	g_CheckTimer = setTimeout(() => {
		if (callback) {
			callback();
		}

		checkCardApps();
	}, 1000 * seconds);
}

function checkCardApps() {
	if (g_RequestInFlight) {
		log(chalk.red('Wanted to request a web session, but a request is already in flight.'));
		return;
	}

	log('Requesting a web session...');

	client.webLogOn();
}

let argsStartIdx = 2;
if (process.argv[0] === 'steamcardfarmer') {
	argsStartIdx = 1;
}

if (process.argv.length === argsStartIdx + 2) {
	log('Reading Steam credentials from command line');
	client.logOn({
		accountName: process.argv[argsStartIdx],
		password: process.argv[argsStartIdx + 1],
		logonID: 66666666,
	});
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
			log(`Error: ${err}`);
			shutdown(1);
			return;
		}

		log('Initializing Steam client...');
		client.logOn({
			accountName: result.username,
			password: result.password,
			logonID: 66666666,
		});
	});
}

process.on('SIGINT', () => {
	log('Logging off and shutting down...');
	shutdown(0);
});

client.on('loggedOn', () => {
	log('Logged into Steam!');
});

client.on('error', (e) => {
	log(chalk.red(`Error: ${e}`));

	if (g_CheckTimer) {
		clearTimeout(g_CheckTimer);
	}
});

client.on('disconnected', (eResult, msg) => {
	log(chalk.red(`Disconnected: Eresult.${eResult} - ${msg}`));

	if (g_CheckTimer) {
		clearTimeout(g_CheckTimer);
	}
});

client.on('newItems', (count) => {
	if (count === 0) {
		return;
	}

	log(chalk.yellowBright(`Got notification of new inventory items: ${count} new item${count === 1 ? '' : 's'}`));
	checkCardsInSeconds(1);
});

client.on('webSession', (sessionID, cookies) => {
	if (g_RequestInFlight) {
		log(chalk.red('Got a web session, but a request is already in flight.'));
		return;
	}

	g_RequestInFlight = true;

	log('Got a web session, checking card drops...');

	cookies.forEach((cookie) => {
		g_Jar.setCookie(cookie, 'https://steamcommunity.com');
	});

	let url = 'https://steamcommunity.com/';

	if (client.vanityURL) {
		url += `id/${client.vanityURL}`;
	} else {
		url += `profiles/${client.steamID.getSteamID64()}`;
	}

	request({
		url: `${url}/badges/?l=english&p=${g_Page}`,
		gzip: true,
		followRedirect: false,
		timeout: 10000,
	}, (err, response, body) => {
		g_RequestInFlight = false;

		if (err || response.statusCode !== 200) {
			log(chalk.red(`Couldn't request badge page: ${err || `HTTP error ${response.statusCode}`}`));
			checkCardsInSeconds(30);
			return;
		}

		if (body.includes('g_steamID = false')) {
			log(chalk.red('Badge page loaded, but its logged out'));
			checkCardsInSeconds(30);
			return;
		}

		let lowHourApps = [];
		const hasDropsApps = [];

		const $ = Cheerio.load(body);

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

				log(`App ${app.appid} - ${chalk.green(app.title)} - Playtime: ${chalk.green(app.playtime)} min`);
			});

			minPlaytime = 120 - minPlaytime;

			log(
				`Idling ${chalk.green(lowHourApps.length)} app${lowHourApps.length === 1 ? '' : 's'}`
				+ ` up to 2 hours. This will take ${chalk.green(minPlaytime)} minutes.`,
			);

			client.gamesPlayed(lowHourApps.map(app => app.appid));

			checkCardsInSeconds(60 * minPlaytime, () => {
				log('Stopped idling previous apps.');
				client.gamesPlayed([]);
			});
		} else if (hasDropsApps.length > 0) {
			const totalDropsLeft = hasDropsApps.reduce((sum, { drops }) => sum + drops, 0);
			const appToIdle = hasDropsApps[0];

			log(
				`${chalk.green(totalDropsLeft)} card drop${totalDropsLeft === 1 ? '' : 's'}`
				+ ` remaining across ${chalk.green(hasDropsApps.length)} app${hasDropsApps.length === 1 ? '' : 's'}`
				+ ` ${chalk.cyan(`(page ${g_Page})`)}`,
			);

			log(
				`Idling app ${appToIdle.appid} "${chalk.green(appToIdle.title)}" - `
				+ `${chalk.green(appToIdle.drops)} drop${appToIdle.drops === 1 ? '' : 's'} remaining.`,
			);

			client.gamesPlayed(appToIdle.appid);

			// 20 minutes to be safe, we should automatically check when
			// Steam notifies us that we got a new item anyway
			checkCardsInSeconds(1200);
		} else if (g_Page <= (parseInt($('.pagelink').last().text(), 10) || 1)) {
			log(chalk.green(`No drops remaining on page ${g_Page}`));
			g_Page += 1;
			log(`Checking page ${g_Page}...`);
			checkCardsInSeconds(1);
		} else {
			log(chalk.green('All card drops received! Shutting down...'));
			shutdown(0);
		}
	});
});
