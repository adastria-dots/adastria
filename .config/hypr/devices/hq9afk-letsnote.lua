local B = require("utils.bootstrap")
local L = require("utils.layout")

local monitors = {
	{ "eDP-1", "preferred", "0x0" },
}

B.setup_displays(monitors)

L.register(2)

hl.config({ input = { scroll_method = "no_scroll" } })

hl.monitor({
	output = "DP-2",
	mode = "preferred",
	position = "auto",
	mirror = "eDP-1",
})

B.auto_start({ 
	"fcitx5",
	"keqing-shell"
 })
