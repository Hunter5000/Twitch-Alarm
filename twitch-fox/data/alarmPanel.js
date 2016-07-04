addon.port.on("alarmPanelTextUpdate", function(alarmText) {
	document.getElementById("alarmText").textContent = alarmText;
});

addon.port.on("alarmPanelTitleUpdate", function(alarmTitle) {
	document.getElementById("alarmTitle").textContent = alarmTitle;
});