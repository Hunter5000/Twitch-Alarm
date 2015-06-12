var {
    ToggleButton
} = require("sdk/ui/button/toggle");

var _ = require("sdk/l10n").get;
var panels = require("sdk/panel")
var self = require("sdk/self");
var pgworkr = require("sdk/page-worker")
var ss = require("sdk/simple-storage");
var preferences = require("sdk/simple-prefs")

//Default settings
//Follower
if (ss.storage.followedStreamers == null) {
    ss.storage.followedStreamers = []
}

//Alarm
if (ss.storage.updateInterval == null) {
    ss.storage.updateInterval = 1
}

if (ss.storage.soundAlarm == null) {
    ss.storage.soundAlarm = true
}
if (ss.storage.alarmLimit == null) {
    ss.storage.alarmLimit = false
}
if (ss.storage.alarmLength == null) {
    ss.storage.alarmLength = 10
}
if (ss.storage.uniqueIds == null) {
    ss.storage.uniqueIds = true
}
if (ss.storage.streamIds == null) {
    ss.storage.streamIds = []
}
if (ss.storage.debounce == null) {
    ss.storage.debounce = 40
}

//Interface
if (ss.storage.liveQuality == null) {
    ss.storage.liveQuality = "best"
}
if (ss.storage.hideInfo == null) {
    ss.storage.hideInfo = false
}
if (ss.storage.hideOffline == null) {
    ss.storage.hideOffline = false
}
if (ss.storage.sortMethod == null) {
    ss.storage.sortMethod = "recent"
}
if (ss.storage.openTab == null) {
    ss.storage.openTab = true
}
if (ss.storage.openLive == null) {
    ss.storage.openLive = false
}
if (ss.storage.openPopout == null) {
    ss.storage.openPopout = false
}
if (ss.storage.previewWait == null) {
    ss.storage.previewWait = 30
}
if (ss.storage.tutorialOn == null) {
    ss.storage.tutorialOn = true
}

var online_streamers = [];
var online_games = [];
var online_titles = [];
var online_viewers = [];
var online_avatars = [];
var offline_streamers = [];
var counter_names = [];
var counter_nums = [];
var counter_off = 0

var waittime = ss.storage.updateInterval

var blank = self.data.url("blank.html")

var {
    setInterval, clearInterval, setTimeout, clearTimeout
} = require("sdk/timers")

var Request = require("sdk/request").Request;
var tabs = require("sdk/tabs")
var alarmOn = false
var alarmCause = ""
var panelOn = false
var alarm_interval = null
var update_interval = null
var badge_timeout = null
var alarm_counter = 0

var httpHeaders = {
    'Accept': "application/vnd.twitchtv.v2+json",
    'Client-ID': "t163mfex6sggtq6ogh0fo8qcy9ybpd6"
};

var button = ToggleButton({
    id: "my-button",
    label: _("clickOpen_"),
    icon: {
        "16": "./ico16.png",
        "32": "./ico32.png",
        "64": "./ico64.png"
    },
    badge: null,
    badgeColor: "#6441A5",
    onChange: handleChange
});

var panel = panels.Panel({
    contentURL: self.data.url("streamerList.html"),
    width: 500,
    height: 500,
    onHide: handleHide
});

var settingsPanel = panels.Panel({
    contentURL: self.data.url("settings.html"),
    width: 660,
    height: 600,
    //onHide: handleHide
});

function openSettings() {
    packageSettings()
    settingsPanel.show({

    });
}

function handleChange(state) {
    if (state.checked) {
        button.label = _("clickClose_")
        panelOn = true
        panel.show({
            position: button
        });
    }
}

function handleHide() {
    button.label = _("clickOpen_")
    panelOn = false
    button.state('window', {
        checked: false
    });
}

function updateBadge() {
    if (online_streamers.length > 0) {
        button.badge = online_streamers.length
    } else {
        button.badge = null
    }

}

function resetBadgeColor() {
    button.badgeColor = "#6641A5"
    clearTimeout(badge_timeout)
}

function playAlert() {
    button.badgeColor = "#FF0000"
    badge_timeout = setTimeout(resetBadgeColor, 250)
    if (ss.storage.soundAlarm) {
        pgworkr.Page({
            contentScript: "new Audio('alert2.ogg').play()",
            contentURL: blank
        });
    }
    if (ss.storage.alarmLimit) {
        alarm_counter = alarm_counter + 1
        if (alarm_counter >= Math.ceil(ss.storage.alarmLength)) {
            alarm_counter = 0
            clearInterval(alarm_interval)
            alarmOn = false
            alarmCause = ""
                //console.log("Alarm automatically stopped")
            if (panelOn) {
                panelUpdate()
            }
        }
    } else {
        alarm_counter = 0
    }
}

function containsValue(list, obj) {
    if ((list.indexOf(obj)) > -1) {
        return true
    } else {
        return false
    }
}

//Credit for the next function goes to Nekto of "Livestreamer launch on twitch.tv"

function go(url, quality) {
    var {
        Cc, Ci
    } = require("chrome");
    // create an nsIFile for the executable
    var file = Cc["@mozilla.org/file/local;1"]
        .createInstance(Ci.nsIFile);
    var platform = require("sdk/system").platform;
    //console.log(platform)
    if (platform.toLowerCase() == "winnt") {
        //For Windows
        /*Initializing with full path to cmd.exe which should normally be in "ComSpec" environment variable*/
        file.initWithPath(
            Cc["@mozilla.org/process/environment;1"]
            .getService(Ci.nsIEnvironment)
            .get("COMSPEC")
        );
    } else {
        //For non-Windows? Hopefully this works
        file.initWithPath("/usr/bin/open");
    }
    // create an nsIProcess
    var process = Cc["@mozilla.org/process/util;1"]
        .createInstance(Ci.nsIProcess);

    process.init(file);
    var args;
    // Run the process.
    // If first param is true, calling thread will be blocked until
    // called process terminates.
    // Second and third params are used to pass command-line arguments
    // to the process.
    if (platform == "darwin") {
        args = ["-a", "/Library/Frameworks/Python.framework/Versions/2.7/bin/livestreamer", "--args", url, quality];
    } else {
        args = ["/K", "livestreamer", url, quality];
    }
    process.run(false, args, args.length);
};

//Credit for these next four functions goes to Ben Clive of "Twitch.tv Stream Browser"

function checkChannels(callbackFunc, favList) {
    for (var key in favList) {
        var request = Request({
            url: "https://api.twitch.tv/kraken/streams/" + favList[key],
            onComplete: callbackFunc,
            headers: httpHeaders
        });
        request.get();
    }
}

function checkChannel(callbackFunc, channel) {
    if (typeof(channel) != "string") {
        return;
    }
    counter_off = counter_off + 1
    var request = Request({
        url: "https://api.twitch.tv/kraken/streams/" + channel + "?" + counter_off,
        onComplete: callbackFunc,
        headers: httpHeaders
    });
    request.get();
}

function getFollowedChannels(callbackFunc, name, offset) {
    var request = Request({
        url: "https://api.twitch.tv/kraken/users/" + name + "/follows/channels?offset=" + offset + "&limit=25&sortby=created_at&direction=DESC",
        onComplete: callbackFunc,
        headers: httpHeaders
    });
    request.get();
}

function importFollowers(name, offset) {
    //console.log("Importing followed channels from " + name + "...")
    getFollowedChannels(function(response) {
        if (response.json == null) {
            return;
        }
        if (typeof response.json.status != 'undefined' && response.json.status != 200) {
            //console.error("Error: [" + response.json.status + "] " + response.json.message);
            return;
        }
        var follows = response.json.follows;
        for (var key in follows) {
            var item = follows[key];
            var channelName = item.channel.name;
            if (!containsValue(ss.storage.followedStreamers, channelName)) {
                ss.storage.followedStreamers.push(channelName)
                packageSettings()
            }
        }
        // Get more if they exist
        //console.log("About to check for more followers: " + offset + "/" + response.json._total);
        if (response.json._total > (offset + 25)) {
            //console.log("Checking name " + name + " with offset " + offset);
            importFollowers(name, offset + 25);
        } else {
            //console.log("Import process complete")
            packageSettings()
        }
    }, name, offset);
}

//Now for my work...

function manageOnlineStreamers(remadd, name_, game_, title_, viewers_, avatar_) {
    //0 to remove, 1 to add, 2 to update
    if (remadd == 0) {
        var namekey = online_streamers.indexOf(name_)
        if (namekey > -1) {
            online_streamers.splice(namekey, 1)
            online_games.splice(namekey, 1)
            online_titles.splice(namekey, 1)
            online_viewers.splice(namekey, 1)
            online_avatars.splice(namekey, 1)
        }
    }
    if (remadd == 1) {
        var namekey = online_streamers.indexOf(name_)
        if (namekey < 0) {
            online_streamers.unshift(name_)
            online_games.unshift(game_)
            online_titles.unshift(title_)
            online_viewers.unshift(viewers_)
            online_avatars.unshift(avatar_)
        }
    }
    if (remadd == 2) {
        var namekey = online_streamers.indexOf(name_)
        if (namekey > -1) {
            online_games[namekey] = game_
            online_titles[namekey] = title_
            online_viewers[namekey] = viewers_
            online_avatars[namekey] = avatar_
        }
    }
    if (panelOn) {
        panelUpdate()
    }
    //Let's update the panel too while we're changing values...
}

function counterTest(_name, _on) {
    if (_on) {
        var magicnum = Math.ceil(ss.storage.debounce / waittime)
        var nameindex = counter_names.indexOf(_name)
        counter_nums[nameindex] = (counter_nums[nameindex] + 1)
        console.log(_name, counter_nums[nameindex])
        if (counter_nums[nameindex] >= magicnum) {
            //Streamer is confirmed offline
            console.log(_name + " has been offline for enough consecutive time. Confirmed as offline.")
            manageOnlineStreamers(0, _name)
            counter_names.splice(nameindex, 1);
            counter_nums.splice(nameindex, 1);
        }
    } else {
        console.log(_name + " may have gone offline. Starting counter test...")
        counter_names.push(_name)
        counter_nums.push(0)
    }
}

function cleanOnlineStreamers() {
    for (var key in online_streamers) {
        checkChannel(function(response) {
            if (response.json != null) {
                var stream = response.json.stream
                var chann = response.json._links.self.split("/streams/")[1]
                var counterOn = containsValue(counter_names, chann)
                if (stream != null) {
                    if (!counterOn) {
                        //Streamer is online as normal
                        //Update
                        var strname = stream.channel.name
                        var game = stream.channel.game
                        var title = stream.channel.status
                        var viewers = stream.viewers
                        var avatar = stream.channel.logo
                        var namekey = online_streamers.indexOf(strname)
                        if ((game != online_games[namekey]) || (title != online_titles[namekey]) || (avatar != online_avatars[namekey]) || (viewers != online_viewers[namekey])) {
                            //Something has changed... time to update
                            manageOnlineStreamers(2, strname, game, title, viewers, avatar)
                        }
                    } else {
                        //Stream has come back online
                        //Remove from counter system
                        console.log(chann + " has come back online. Confirmed as online.")

                        var countIndex = counter_names.indexOf(chann)
                        counter_names.splice(countIndex, 1)
                        counter_nums.splice(countIndex, 1)
                        addStrId(response.json.stream._id)

                        //Update
                        var strname = stream.channel.name
                        var game = stream.channel.game
                        var title = stream.channel.status
                        var viewers = stream.viewers
                        var avatar = stream.channel.logo
                        var namekey = online_streamers.indexOf(strname)
                        if ((game != online_games[namekey]) || (title != online_titles[namekey]) || (avatar != online_avatars[namekey]) || (viewers != online_viewers[namekey])) {
                            //Something has changed... time to update
                            manageOnlineStreamers(2, strname, game, title, viewers, avatar)
                        }
                    }
                } else {
                    //Stream cannot be found
                    counterTest(chann, counterOn)
                }
            } else {
                //Response cannot be found
                //This means that a streamer who was online got deleted... perhaps due to an admin shutdown?
                //We cannot be truly sure of who we're responding too... so run for the hills!
                forceRefresh()
            }
        }, online_streamers[key])
        if (!(containsValue(ss.storage.followedStreamers, online_streamers[key]))) {
            //Streamer has been unfollowed
            manageOnlineStreamers(0, online_streamers[key])
        }
    }
}

function checkStrId(id_) {
    if (!containsValue(ss.storage.streamIds, id_) || !ss.storage.uniqueIds) {
        return true
    } else {
        return false
    }
}

function addStrId(id_) {
    if (!containsValue(ss.storage.streamIds, id_)) {
        if (ss.storage.streamIds.length > 999) {
            ss.storage.splice(0, 1)
        }
        ss.storage.streamIds.push(id_)
    }
}

function updateChannels() {
    updateBadge()
    if (!(containsValue(ss.storage.followedStreamers, alarmCause)) && (alarmCause != "")) {
        //console.log("Alarm cause is no longer being followed")
        clearInterval(alarm_interval)
        alarmOn = false
        alarmCause = ""
        if (panelOn) {
            panelUpdate()
        }
    }
    if (!(containsValue(online_streamers, alarmCause)) && (alarmCause != "")) {
        //console.log("Alarm cause is no longer online")
        clearInterval(alarm_interval)
        alarmOn = false
        alarmCause = ""
        if (panelOn) {
            panelUpdate()
        }
    }
    cleanOnlineStreamers()
    offline_streamers = generateOfflineStreamers()
    checkChannels(function(response) {
        if (response.json != null) {
            var stream = response.json.stream
            if (stream != null) {
                var strname = stream.channel.name
                var game = stream.channel.game
                var title = stream.channel.status
                var viewers = stream.viewers
                var avatar = stream.channel.logo
                var strid = stream._id
                    //New streamer has come online
                manageOnlineStreamers(1, strname, game, title, viewers, avatar)
                if ((!alarmOn) && checkStrId(strid)) {
                    alarmOn = true
                    alarmCause = strname
                    playAlert()
                    alarm_interval = setInterval(playAlert, 1000) //this is the alarm part
                    if (panelOn) {
                        panelUpdate()
                    }
                }
                addStrId(strid)
            } else {
                //Offline streamer is still offline
            }
        } else {
            //Response not found
        }
    }, offline_streamers);
}

update_interval = setInterval(updateChannels, waittime * 1000);
updateChannels()

function generateOfflineStreamers() {
    var offstreamers = []
    for (var key in ss.storage.followedStreamers) {
        if (!(containsValue(online_streamers, ss.storage.followedStreamers[key]))) {
            offstreamers.push(ss.storage.followedStreamers[key])
        }
    }
    return offstreamers
}

function forceRefresh() {
    online_streamers = []
    online_games = []
    online_titles = []
    online_viewers = []
    online_avatars = []
    offline_streamers = []
    counter_names = []
    counter_nums = []
}

panel.on("show", function() {
    //console.log("Shipping payload...")
    panelUpdate()
});

panel.port.on("openTab", function(payload) {
    tabs.open("http://www.twitch.tv/" + payload)
})

panel.port.on("openLive", function(payload) {
    go("http://www.twitch.tv/" + payload, ss.storage.liveQuality)
})

panel.port.on("openSettings", function(payload) {
    openSettings()
})

settingsPanel.port.on("importSettings", function(payload) {
    //Retrieve setting updates
    ss.storage.followedStreamers = payload[0]
    ss.storage.updateInterval = payload[1]
    ss.storage.soundAlarm = payload[2]
    ss.storage.alarmLimit = payload[3]
    ss.storage.alarmLength = payload[4]
    ss.storage.uniqueIds = payload[5]
    ss.storage.streamIds = payload[6]
    ss.storage.debounce = payload[7]
    ss.storage.liveQuality = payload[8]
    ss.storage.hideInfo = payload[9]
    ss.storage.hideOffline = payload[10]
    ss.storage.sortMethod = payload[11]
    ss.storage.openTab = payload[12]
    ss.storage.openLive = payload[13]
    ss.storage.openPopout = payload[14]
    ss.storage.previewWait = payload[15]
    ss.storage.tutorialOn = payload[16]
})

settingsPanel.port.on("importUser", function(payload) {
    importFollowers(payload, 0)
})

settingsPanel.port.on("forceRefresh", function() {
    forceRefresh()
})

panel.port.on("endAlarm", function() {
    if (alarm_interval != null) {
        clearInterval(alarm_interval)
        alarmOn = false
        alarmCause = ""
            //console.log("Alarm stopped")
    }
    if (panelOn) {
        panelUpdate()
    }
})

preferences.on("settingsButton", function() {
    openSettings()
});

function panelUpdate() {
    //Should update when something has changed or alarm turns off
    //Give the settings to the panel
    panel.port.emit("updatePage", [
        online_streamers,
        online_games,
        online_titles,
        online_viewers,
        online_avatars,
        offline_streamers,
        alarmOn,
        ss.storage.followedStreamers,
        ss.storage.hideInfo,
        ss.storage.hideOffline,
        ss.storage.sortMethod,
        ss.storage.openTab,
        ss.storage.openLive,
        ss.storage.openPopout,
        ss.storage.previewWait,
        ss.storage.tutorialOn,
        alarmCause
    ]);
}

function packageSettings() {
    //Give the settings to the settings script
    settingsPanel.port.emit("onSettings", [
        ss.storage.followedStreamers,
        ss.storage.updateInterval,
        ss.storage.soundAlarm,
        ss.storage.alarmLimit,
        ss.storage.alarmLength,
        ss.storage.uniqueIds,
        ss.storage.streamIds,
        ss.storage.debounce,
        ss.storage.liveQuality,
        ss.storage.hideInfo,
        ss.storage.hideOffline,
        ss.storage.sortMethod,
        ss.storage.openTab,
        ss.storage.openLive,
        ss.storage.openPopout,
        ss.storage.previewWait,
        ss.storage.tutorialOn,
        self.version
    ])
}

exports.onUnload = function(reason) {
    console.log(reason)
    if ((reason == "disable") || (reason == "uninstall")) {
        //Reset all of the storage values

        //Followers
        ss.storage.followedStreamers = null

        //Alarm
        ss.storage.updateInterval = null
        ss.storage.soundAlarm = null
        ss.storage.alarmLimit = null
        ss.storage.alarmLength = null
        ss.storage.uniqueIds = null
        ss.storage.streamIds = null
        ss.storage.debounce = null

        //Interface
        ss.storage.liveQuality = null
        ss.storage.hideInfo = null
        ss.storage.hideOffline = null
        ss.storage.sortMethod = null
        ss.storage.openTab = null
        ss.storage.openLive = null
        ss.storage.openPopout = null
        ss.storage.previewWait = null
        ss.storage.tutorialOn = null

        console.log("Good bye!")
    } else if (reason == "upgrade"){
        //Let's re-enable tutorials so they know the new features
        ss.storage.tutorialOn = true
    } else {
        console.log("Good night!")
    }
};

updateChannels();