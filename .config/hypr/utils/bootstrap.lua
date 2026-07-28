-- BOOTSTRAP

-- must match hyprland.lua's V.wpm
local WPM = 10

local B = {}

function B.assign_workspaces(monitor_names, wpm)
	wpm = wpm or WPM
	for mon_idx, monitor_name in ipairs(monitor_names) do
		local base = (mon_idx - 1) * wpm
		for i = 1, wpm do hl.workspace_rule({ workspace = base + i, monitor = monitor_name, persistent = true }) end
	end
end

function B.auto_start(cmds)
	return hl.on("hyprland.start", function()
		for _, cmd in ipairs(cmds) do hl.exec_cmd(cmd) end
	end)
end

function B.load_device()
	local f = io.open("/etc/hostname")
	local device = f and f:read("*l")
	if f then f:close() end
	return require("devices." .. (device or "hq9afk"))
end

function B.mod(key, mods)
	mods = mods or ""
	local parts = { "SUPER" }
	if mods:find("c") then table.insert(parts, "CTRL") end
	if mods:find("a") then table.insert(parts, "ALT") end
	if mods:find("s") then table.insert(parts, "SHIFT") end
	table.insert(parts, key)
	return table.concat(parts, " + ")
end

function B.set_monitor(mon, mode, pos, scale, rot)
	hl.monitor({
		output = mon or "",
		mode = mode or "preferred",
		position = pos or "auto",
		scale = scale or 1,
		transform = rot or 0,
	})
end

function B.setup_displays(monitors, wpm)
	local monitor_names = {}

	if monitors then
		for _, monitor in ipairs(monitors) do
			table.insert(monitor_names, monitor[1])
			B.set_monitor(monitor[1], monitor[2], monitor[3], monitor[4], monitor[5])
		end
	else
		for _, mon in ipairs(hl.get_monitors()) do
			table.insert(monitor_names, mon.name)
			B.set_monitor(mon.name)
		end
	end

	B.assign_workspaces(monitor_names, wpm)
end

return B
