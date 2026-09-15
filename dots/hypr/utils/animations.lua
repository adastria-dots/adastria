-- ANIMATIONS TOGGLE (persistent across restarts)

local M = {}

local function state_path()
	local home = os.getenv("HOME")
	local state_home = os.getenv("XDG_STATE_HOME") or (home .. "/.local/state")
	return state_home .. "/adastria/animations"
end

local function read_enabled()
	local f = io.open(state_path(), "r")
	if not f then return true end
	local v = f:read("*l")
	f:close()
	return v ~= "0"
end

local function write_enabled(enabled)
	local path = state_path()
	os.execute("mkdir -p '" .. path:match("^(.*)/[^/]+$") .. "'")
	local f = io.open(path, "w")
	if not f then return end
	f:write(enabled and "1" or "0")
	f:close()
end

local enabled = read_enabled()

function M.enabled() return enabled end

function M.toggle()
	enabled = not enabled
	write_enabled(enabled)
	hl.config({ animations = { enabled = enabled } })
	hl.exec_cmd("notify-send -t 1500 'Animations: " .. (enabled and "On" or "Off") .. "'")
end

return M
