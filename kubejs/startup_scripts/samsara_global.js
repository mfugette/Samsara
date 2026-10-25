// Samsara — creates global.SMS, the namespace every samsara_*.js server script hangs
// its config and functions on.
//
// It has to be created HERE. On KubeJS 7 `global` is read-only in server and client
// scripts (J38, read from the jar): BuiltinKubeJSPlugin binds the real HashMap only
// for startup scripts and hands the others a GlobalUnmodifiableMap, whose put()
// throws "'global' cannot be assigned to in client or server scripts". The 1.20.1
// line every server script opened with, `global.SMS = global.SMS || {}`, threw on
// that and aborted all six files -- no /karma, no karma, no rebirth.
//
// Only the KEY is read-only. A put stores this JS object unconverted and a read
// returns it as is, so the server scripts add to it freely, and what they add
// survives /reload exactly as before.
//
// Startup scripts run ONCE, at game launch: adding or editing this file needs a game
// restart, not /reload.

global.SMS = global.SMS || {}
