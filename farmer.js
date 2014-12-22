var Steam = require('steam');
var SteamStuff = require('steamstuff');
var prompt = require('prompt');
var request = require('request');
var Cheerio = require('cheerio');

var client = new Steam.SteamClient();
SteamStuff(Steam, client);

var g_Jar = request.jar();
request = request.defaults({"jar": g_Jar});

var g_CheckTimer;

function log(message) {
	var date = new Date();
	var time = [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()];
	
	for(var i = 1; i < 6; i++) {
		if(time[i] < 10) {
			time[i] = '0' + time[i];
		}
	}
	
	console.log(time[0] + '-' + time[1] + '-' + time[2] + ' ' + time[3] + ':' + time[4] + ':' + time[5] + ' - ' + message);
};

var g_Username;
var g_Password;

prompt.start();
prompt.get({
	"properties": {
		"username": {
			"required": true,
		},
		"password": {
			"hidden": true,
			"required": true
		}
	}
}, function(err, result) {
	if(err) {
		log("Error: " + err);
		shutdown(1);
		return;
	}
	
	log("Initializing Steam client...");
	client.logOn({
		"accountName": result.username,
		"password": result.password
	});
	
	g_Username = result.username;
	g_Password = result.password;
});

client.on('loggedOn', function() {
	log("Logged into Steam!");
});

client.on('webSessionID', function(sessionID) {
	checkCardApps();
});

client.on('error', function(e) {
	log("Error: " + e);
	setTimeout(function() {
		client.logOn({
			"accountName": g_Username,
			"password": g_Password
		});
	}, 10000);
});

client._handlers[Steam.EMsg.ClientItemAnnouncements] = function() {
	log("Got new item notification!");
	checkCardApps();
};

function checkCardApps() {
	if(g_CheckTimer) {
		clearTimeout(g_CheckTimer);
	}
	
	log("Checking card drops...");
	
	client.webLogOn(function(cookies) {
		cookies.forEach(function(cookie) {
			g_Jar.setCookie(cookie, 'https://steamcommunity.com');
		});
		
		request("https://steamcommunity.com/my/badges/", function(err, response, body) {
			if(response && response.statusCode !== 200) {
				err = "HTTP " + response.statusCode;
			}
			
			if(err) {
				log("Couldn't request badge page: " + err);
				checkCardsInSeconds(30);
				return;
			}
			
			var appsWithDrops = 0;
			var totalDropsLeft = 0;
			var appLaunched = false;
			
			var $ = Cheerio.load(body);
			var infolines = $('.progress_info_bold');
			for(var i = 0; i < infolines.length; i++) {
				var match = $(infolines[i]).text().match(/(\d+) card drops? remaining/);
				if(!match || !parseInt(match[1], 10)) {
					continue;
				}
				
				appsWithDrops++;
				totalDropsLeft += parseInt(match[1], 10);
				
				if(!appLaunched) {
					appLaunched = true;
					var urlparts = $(infolines[i]).parent().find('.badge_title_playgame a').attr('href').split('/');
					var appid = urlparts[urlparts.length - 1];
					var title = $(infolines[i]).parent().parent().find('.badge_title').html().replace('&#xA0;<span class="badge_view_details">View details</span>', '').trim();
					log("Idling app " + appid + " \"" + title + "\" - " + match[1] + " drop" + (match[1] == 1 ? '' : 's') + " remaining");
					client.gamesPlayed([parseInt(appid, 10)]);
				}
			}
			
			log(totalDropsLeft + " card drop" + (totalDropsLeft == 1 ? '' : 's') + " remaining across " + appsWithDrops + " app" + (appsWithDrops == 1 ? '' : 's'));
			if(totalDropsLeft == 0) {
				shutdown(0);
			} else {
				checkCardsInSeconds(1200); // 20 minutes to be safe, we should automatically check when Steam notifies us that we got a new item anyway
			}
		});
	});
}

function checkCardsInSeconds(seconds) {
	g_CheckTimer = setTimeout(checkCardApps, (1000 * seconds));
}

process.on('SIGINT', function() {
	log("Logging off and shutting down");
	shutdown(0);
});

function shutdown(code) {
	client.gamesPlayed([]);
	client.logOff();
	setTimeout(function() {
		process.exit(code);
	}, 500);
}
