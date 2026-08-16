-- SCROLLUMNS LAYOUT (scrolling columns)

local M = {}

local max_cols
local scroll = {}
local overrides = {}
local strict = {}
local monocle = {}

local function resolve_max_cols(cols, mon_name)
	if type(cols) == "table" then return cols[mon_name] or 1 end
	return cols or 1
end

local function notify(text)
	hl.exec_cmd("notify-send -t 1500 '" .. text .. "'")
end

local function set_monocle_tag(addr, enabled)
	hl.dispatch(hl.dsp.window.tag({ window = "address:" .. addr, tag = "monocle", action = enabled and "add" or "remove" }))
end

function M.bump(delta)
	local ws = hl.get_active_workspace()
	local mon = hl.get_active_monitor()
	if not ws or not mon then return end
	local current = overrides[ws.id] or resolve_max_cols(max_cols, mon.name)
	local new_val = math.max(1, math.min(6, current + delta))
	overrides[ws.id] = new_val
	hl.dispatch(hl.dsp.layout("sync"))
	notify("Workspace: " .. ws.name .. "\nColumns: " .. new_val)
end

function M.toggle_strict()
	local ws = hl.get_active_workspace()
	if not ws then return end
	local enabled = not strict[ws.id]
	strict[ws.id] = enabled
	hl.dispatch(hl.dsp.layout("sync"))
	notify("Workspace: " .. ws.name .. "\nStrict Columns: " .. (enabled and "On" or "Off"))
end

function M.reset()
	local ws = hl.get_active_workspace()
	if not ws then return end
	overrides[ws.id] = nil
	strict[ws.id] = nil
	for _, w in ipairs(hl.get_workspace_windows(ws.id)) do
		if monocle[w.address] then set_monocle_tag(w.address, false) end
		monocle[w.address] = nil
	end
	hl.dispatch(hl.dsp.layout("sync"))
	notify("Workspace: " .. ws.name .. "\nReset to defaults")
end

local function toggle_monocle()
	local win = hl.get_active_window()
	if not win then return end
	local enabled = not monocle[win.address]
	monocle[win.address] = enabled or nil
	set_monocle_tag(win.address, enabled)
	hl.dispatch(hl.dsp.layout("sync"))
end

function M.toggle_monocle_or_maximize()
	local win = hl.get_active_window()
	if win and win.workspace and win.workspace.tiled_layout == "lua:scrollumns" then
		toggle_monocle()
		return
	end
	hl.dispatch(hl.dsp.window.fullscreen({ mode = "maximized", action = "toggle" }))
end

function M.register(cols)
	max_cols = cols

	hl.on("window.active", function(win)
		if win and win.workspace and win.workspace.tiled_layout == "lua:scrollumns" then hl.dispatch(hl.dsp.layout("sync")) end
	end)

	hl.on("window.close", function(win)
		if win and win.address then monocle[win.address] = nil end
	end)

	hl.layout.register("scrollumns", {
		recalculate = function(ctx)
			local targets = ctx.targets
			local n = #targets
			if n == 0 then return end

			local ws_id = targets[1].window and targets[1].window.workspace and targets[1].window.workspace.id
			local mon_name = targets[1].window and targets[1].window.monitor and targets[1].window.monitor.name
			local cols = (ws_id and overrides[ws_id]) or resolve_max_cols(max_cols, mon_name)

			local is_strict = ws_id and strict[ws_id]

			if n == 1 and not is_strict then
				targets[1]:place({ x = ctx.area.x, y = ctx.area.y, w = ctx.area.w, h = ctx.area.h })
				return
			end

			local visible_cols = is_strict and cols or math.min(n, cols)
			local col_w = ctx.area.w / visible_cols

			local widths, pos, total, focus_i = {}, {}, 0, 1
			for i, t in ipairs(targets) do
				local addr = t.window and t.window.address
				widths[i] = (addr and monocle[addr]) and ctx.area.w or col_w
				pos[i] = total
				total = total + widths[i]
				if t.window and t.window.active then focus_i = i end
			end

			local max_scroll = math.max(0, total - ctx.area.w)
			local scroll_px = math.min((ws_id and scroll[ws_id]) or 0, max_scroll)
			if pos[focus_i] < scroll_px then
				scroll_px = pos[focus_i]
			elseif pos[focus_i] + widths[focus_i] > scroll_px + ctx.area.w then
				scroll_px = pos[focus_i] + widths[focus_i] - ctx.area.w
			end
			scroll_px = math.max(0, math.min(scroll_px, max_scroll))
			if ws_id then scroll[ws_id] = scroll_px end

			local center_shift = total < ctx.area.w and (ctx.area.w - total) / 2 or 0

			for i, t in ipairs(targets) do
				t:place({
					x = ctx.area.x + center_shift + pos[i] - scroll_px,
					y = ctx.area.y,
					w = widths[i],
					h = ctx.area.h,
				})
			end
		end,

		layout_msg = function(_, msg) return msg == "sync" end,
	})

	hl.config({ general = { layout = "lua:scrollumns" } })
end

return M
