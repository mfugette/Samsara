// priority: 60
// Samsara — realm penalties.
//
// PRIORITY 60, above samsara_karma.js (50) and samsara_rebirth.js (40): an EXITING
// handler stops the handlers after it, so the animal-realm placement refusal below
// must run before karma's container-ownership recorder (a refused placement must not
// be recorded), and this file's respawn safety net registers before rebirth's
// respawn handler. KubeJS 7 orders files by `// priority: N` (higher first), then path.
//
// CRITICAL RULE: penalties follow the player's `birthRealm`, NEVER the dimension they
// are standing in. Players still need the Nether (blaze rods, netherite) and the End
// for ordinary progression, so a human walking through a portal is just VISITING and
// takes nothing. Only a player *born* into a realm lives under its rules.
// See design doc section 7.
//
// Effects are declared in config.realmEffects. Realms with no entry have no penalties
// yet (asura, deva, brahma: a design question, not built).
//
// CANCELLING ON KUBEJS 7 (and 6 -- read from both jars): event.cancel() THROWS an
// EventExit, so nothing after it in the handler runs, and a try/catch around it CATCHES
// the exit and silently un-cancels the event. So every refusal here sends its message
// FIRST and calls cancel() LAST, outside any try. cancel() and cancel(false) are the
// same result (INTERRUPT_FALSE).

global.SMS = global.SMS || {}

// The realm a player was BORN into. Falls back to human: a player who has never died
// has no birthRealm recorded, and the human realm is the no-penalty default.
// NOTE: goes through global.SMS.nbtString, which coerces the JAVA String that
// CompoundTag.getString returns into a real JS string. Without that coercion
// `config.realmDimensions[realm]` does not match its JS keys and this returned
// 'human' for every realm -- see the comment on nbtString in samsara_karma.js.
global.SMS.birthRealmOf = player => {
    try {
        var realm = global.SMS.nbtString(global.SMS.persistedTag(player), global.SMS.config.nbt.birthRealm)
        if (realm && global.SMS.isRealm(realm)) return realm
    } catch (ignored) {
        // fall through
    }
    return 'human'
}

// Effects table for a realm, or an empty object.
//
// Coerces the key for the same reason: a Java String passed in from NBT would miss
// every entry in realmEffects, so naraka's maxHealth was never found and the player
// kept full health. THIS was the full-health bug.
global.SMS.effectsFor = realm => {
    if (!realm) return {}
    var key = '' + realm
    return global.SMS.config.realmEffects[key] || {}
}

// ---- Applying and clearing effects -----------------------------------------

// Max health is the only *persistent* attribute change so far, so it has to be
// actively reset when a player is reborn somewhere else -- otherwise a player who
// escapes hell keeps five hearts forever.
const VANILLA_MAX_HEALTH = 20.0

// Read the current max health.
//
// FIRST the attribute's base value, which is exactly what setMaxHealth writes. On
// 1.20.1 Rhino coerced the registry-id string into an Attribute (confirmed in game
// 2026-10-18: before=20, before=14). On KubeJS 7 the parameter is a
// Holder<Attribute>, and whether a string coerces into that is unverified.
//
// THEN vanilla getMaxHealth(), callable by its Mojang name on 1.21.1 (it was an
// unreachable SRG name on 1.20.1, where `player.maxHealth` threw and once disabled
// the penalty outright). It is the TOTAL value (base + modifiers), not the base --
// fine for the "does it differ" test and the log, since setMaxHealth is idempotent.
//
// Returns null when unreadable, which callers must treat as "set it anyway" rather
// than "skip": the whole point is that a missing getter must not disable the penalty.

// How often the preta clamp runs. 4 ticks = 5x/second: frequent enough that a meal
// cannot visibly push the bar past the cap, cheap enough to ignore (it is a numeric
// compare per online player, and it early-returns on realms with no foodCap).
const PRETA_INTERVAL_TICKS = 4

// On global.SMS, not a file-local `let`, for the same reason global.SMS.tickClock is:
// `global` survives /reload, so the clamp's cadence is not reset every time the
// scripts reload. It also lets the offline harness drive the throttle deterministically
// instead of inheriting whatever phase an earlier test left it in.
global.SMS.pretaCounter = global.SMS.pretaCounter || 0

function readMaxHealth(player) {
    try {
        var v = Number(player.getAttributeBaseValue('minecraft:generic.max_health'))
        if (isFinite(v) && v > 0) return v
    } catch (ignored) {
        // no string -> Holder coercion; try the vanilla getter
    }
    try {
        var t = Number(player.getMaxHealth())
        if (isFinite(t) && t > 0) return t
    } catch (ignored2) {
        // neither readable
    }
    return null
}

// ---- Clearing the PREVIOUS life -------------------------------------------
//
// DESIGN RULE: nothing from a previous life may carry into the current one.
//
// Most realm penalties are checked LIVE against birthRealm, so they stop applying the
// instant birthRealm changes and need no teardown. But anything that is stored --
// an attribute, queued work, a cached decision -- survives the rebirth unless it is
// explicitly cleared, and that is a bug every time.
//
// This function is the single place that resets stored per-life state. Every new
// effect that writes something persistent MUST be undone here, not just skipped while
// the new realm is active.
//
// Registry of what is stored vs live, as of 2026-10-21 (1.21.1):
//   maxHealth       STORED attribute        -> reset by applyRealmEffects (new value)
//   hungerEffect    STORED mob effect       -> cleared below
//   notify cooldown STORED throttle         -> cleared below
//   noCrafting      live check              -> no teardown needed
//   noContainers    live check              -> no teardown needed
//   noBlockPlacing  live check              -> no teardown needed
//   foodMultiplier  live check, corrected inside the meal itself -> nothing stored
//   foodCap         live check              -> no teardown needed
// (The 1.20.1 pendingFoodPenalty queue is gone: the meal is now corrected inside
// foodEaten, so nothing is queued that could land on the next body.)
global.SMS.clearPreviousLife = player => {
    var cleared = []

    // The renewed hunger effect is STORED state on the player: it outlives the realm
    // that applied it, because a MobEffect persists until it lapses or is removed.
    // A preta reborn as a human would otherwise keep starving for up to
    // hungerEffect.durationTicks into their new life. Removed unconditionally rather
    // than only for ex-pretas: /effect clear on an effect you do not have is a no-op,
    // and this must also undo an effect applied before a config change.
    try {
        if (player.isPlayer()) {
            player.runCommandSilent('effect clear @s minecraft:hunger')
            cleared.push('hungerEffect')
        }
    } catch (ignored) {
        // runCommandSilent unavailable; the effect lapses on its own
    }

    // The anti-spam timer for refusal messages. Harmless, but a stale entry means the
    // first refusal in a new life can be silently swallowed.
    try {
        var id2 = '' + player.uuid
        if (global.SMS.lastNotified && global.SMS.lastNotified[id2] !== undefined) {
            delete global.SMS.lastNotified[id2]
            cleared.push('notifyCooldown')
        }
    } catch (ignored) {
        // nothing to clear
    }

    return cleared
}

global.SMS.applyRealmEffects = player => {
    const realm = global.SMS.birthRealmOf(player)

    // A liberated player is outside the cycle, so realm penalties no longer apply --
    // the project notes' liberation section lists realm penalties among the things turned
    // off. Passing an unmapped realm name makes the code below reset maxHealth to
    // vanilla 20 and leaves every live-checked restriction (crafting, containers,
    // placing) reading as absent, which is exactly the intended teardown. Routing
    // the liberation case through the SAME path rather than returning early is what
    // guarantees a player liberated while born-naraka does not keep five hearts.
    var liberated = false
    try {
        liberated = global.SMS.isLiberated(player)
    } catch (ignored) {
        liberated = false
    }

    const fx = liberated ? {} : global.SMS.effectsFor(realm)
    const target = fx.maxHealth === undefined ? VANILLA_MAX_HEALTH : fx.maxHealth

    // Tear down stored state from the life that just ended, BEFORE applying the new
    // realm's effects. Note maxHealth is handled by the set below rather than here:
    // it is always written to the NEW realm's value (defaulting to vanilla 20), so a
    // realm with no maxHealth entry actively resets it rather than inheriting.
    const cleared = global.SMS.clearPreviousLife(player)

    var current = readMaxHealth(player)

    // Set unconditionally when we cannot read the current value -- idempotent, and far
    // better than skipping the penalty because a getter is missing.
    var applied = false
    if (current === null || current !== target) {
        try {
            player.setMaxHealth(target)
            applied = true
        } catch (e) {
            console.warn(`[Samsara] setMaxHealth(${target}) failed: ${e}`)
        }
    }

    // Log loudly enough that the next in-game test can CONFIRM this landed, rather
    // than us inferring it from the health bar. Reads back the attribute afterwards.
    var after = readMaxHealth(player)
    console.info(
        `[Samsara] realm effects: ${player.profile.name} born-${realm}` +
            ` maxHealth target=${target} before=${current} after=${after}` +
            ` (setMaxHealth called: ${applied})` +
            (cleared.length > 0 ? ` [cleared from previous life: ${cleared.join(', ')}]` : '')
    )

    // Current health is deliberately NOT touched -- the port keeps 1.20.1's behaviour.
    // (On 1.20.1 there was no reachable setHealth at all; on 1.21.1 vanilla
    // setHealth/getHealth are callable, so lowering health to the new maximum at once
    // is now possible -- a proposal, not done unasked.) Vanilla clamps health to the
    // maximum on its own, so a player who drops from 20 max to 10 may briefly show a
    // full bar until the next damage or regen tick.

    return realm
}

// Re-apply whenever the player's realm could have changed or the entity was rebuilt.
PlayerEvents.loggedIn(event => {
    global.SMS.applyRealmEffects(event.player)
})

// ORDERING. This used to claim it "runs after the rebirth handler has written the new
// birthRealm". It does not. This file loads before samsara_rebirth.js (alphabetically
// on 1.20.1; by priority 60 > 40 on 1.21.1), so this handler registers first and
// therefore runs first -- reading the PREVIOUS life's birthRealm.
//
// That is why forcing naraka and dying left the player on full health: at the moment
// this ran, birthRealm was still the old realm, so it applied that realm's effects
// (or reset to 20.0) and the rebirth handler then wrote 'naraka' with nothing left to
// re-read it.
//
// Rather than depend on file names, samsara_rebirth.js now calls applyRealmEffects
// itself right after it writes birthRealm. This handler stays as a safety net for
// respawns that the rebirth hook skips (notably an End return, where birthRealm is
// deliberately left alone and the existing realm's effects must persist).
PlayerEvents.respawned(event => {
    // Skip when the rebirth hook is going to handle this respawn itself.
    //
    // Both files hook this event and load order puts THIS one first, so
    // it would otherwise run against the previous life's birthRealm -- visible in the
    // log as a stale pair:
    //     born-asura target=20 ...   <- this handler, old realm
    //     born-preta target=14 ...   <- rebirth hook, correct
    // The result was still right because the correct call landed second, but the first
    // call was wasted work and made the log actively misleading.
    //
    // samsara_rebirth.js sets pendingRebirth at death and clears it when it places the
    // player. If an entry is present, the rebirth hook has not run yet and WILL call
    // applyRealmEffects with the new realm -- so there is nothing useful to do here.
    try {
        var key = '' + event.entity.uuid
        if (global.SMS.pendingRebirth && global.SMS.pendingRebirth[key]) return
    } catch (ignored) {
        // cannot tell: fall through and apply, which is the safe direction
    }

    global.SMS.applyRealmEffects(event.entity)
})

// ---- Animal realm restrictions ---------------------------------------------

// An animal has no hands for tools and no mind for planning. It can still fight,
// forage, break blocks and carry items.

// Which restriction applies to THIS player right now, read fresh from birthRealm
// every time so it stops the instant they are reborn elsewhere.
//
// The old helper was `isAnimalBorn()`, which returned `noCrafting === true` and was
// then used to gate the CONTAINER and BLOCK-PLACING handlers as well. That coupled
// three independent restrictions to one flag:
//   - a realm with noBlockPlacing but no noCrafting would not have blocked placing;
//   - giving any realm noCrafting would silently switch on container and placement
//     restrictions it never asked for.
// Each handler now asks for the specific effect it enforces.
function hasEffect(player, name) {
    if (!player) return false
    try {
        if (!player.isPlayer()) return false
    } catch (ignored) {
        return false
    }

    // Liberation turns every realm penalty off. Checked here rather than in each
    // caller because all four live restrictions (crafting, containers, block
    // placing, and anything added later) funnel through this one function -- so a
    // liberated player born into the animal realm can craft and build again, which
    // is what "realm penalties are turned off for them" means in the project notes.
    try {
        if (global.SMS.isLiberated(player)) return false
    } catch (ignored) {
        // isLiberated unavailable (karma script not loaded): fall through and apply
        // the realm's effects normally rather than silently freeing everyone.
    }

    return global.SMS.effectsFor(global.SMS.birthRealmOf(player))[name] === true
}

// Tell the player why something was refused, but not on every tick of a held click.
const NOTIFY_COOLDOWN_TICKS = 40
// On global.SMS so global.SMS.clearPreviousLife() can reset a player's entry when
// they are reborn. Survives /reload, which is fine -- it is only a message throttle.
global.SMS.lastNotified = global.SMS.lastNotified || {}

function refuse(player, message) {
    try {
        var id = player.uuid ? '' + player.uuid : '' + player.profile.name
        var now = global.SMS.tickClock || 0
        var prev = global.SMS.lastNotified[id]
        if (prev === undefined || now - prev >= NOTIFY_COOLDOWN_TICKS || now < prev) {
            global.SMS.lastNotified[id] = now
            player.tell(Text.gray(message))
        }
    } catch (ignored) {
        // messaging is best-effort
    }
}

// Does this block id look like something an animal should not be able to open?
function isContainerBlock(id) {
    const suffixes = global.SMS.config.containerBlockSuffixes
    for (let i = 0; i < suffixes.length; i++) {
        if (id.endsWith(suffixes[i])) return true
    }
    return false
}

// Block crafting.
//
// ItemEvents.crafted is not cancellable on KubeJS 6 or 7 (both jars: it is posted from
// the craft-result notification, after the fact), so crafting cannot be prevented
// outright. Two levers together get close:
//
//   1. Station access is refused above, which covers the crafting table, anvil,
//      smithing table, loom, stonecutter and the rest.
//   2. The 2x2 inventory grid is client-driven, so the only server-side recourse is
//      to destroy the result after the fact. Crude, but it means an animal gains
//      nothing by crafting, and the message explains why.
ItemEvents.crafted(event => {
    const player = event.entity
    if (!hasEffect(player, 'noCrafting')) return

    try {
        event.item.setCount(0)
        refuse(player, 'An animal cannot craft.')
    } catch (ignored) {
        // if the stack cannot be emptied, the player simply keeps the item
    }
})

// net.minecraft.world.item.BlockItem, for "is this a block the player is placing?".
// Loaded once. Vanilla classes and methods are callable by Mojang name on 1.21.1.
// ItemNameBlockItem (seeds, redstone, string) extends it, so planting counts as
// placing; tools (hoe, axe, shovel), flint and steel, bone meal, buckets and food do
// not, so an animal can still use them.
var BlockItemClass = null
try {
    BlockItemClass = Java.loadClass('net.minecraft.world.item.BlockItem')
} catch (e) {
    console.warn(`[Samsara] could not load BlockItem; animal placement falls back to the id round-trip: ${e}`)
}

// Is this ItemStack a block the player would place?
function isBlockItemStack(stack) {
    if (!stack) return false
    try {
        if (stack.isEmpty()) return false
    } catch (ignored) {
        return false
    }
    if (BlockItemClass) {
        try {
            return stack.getItem() instanceof BlockItemClass
        } catch (ignored2) {
            // fall through to the round-trip
        }
    }
    // Fallback (the proven 1.20.1 test): a real block id round-trips through the
    // block registry; a non-block resolves to the registry default, air, and does
    // not. `!!Block.getBlock(id)` alone is WRONG -- air is a truthy object.
    try {
        var heldId = '' + stack.id
        var resolved = Block.getBlock(heldId)
        return !!resolved && heldId !== 'minecraft:air' && '' + Block.getId(resolved) === heldId
    } catch (ignored3) {
        return false
    }
}

// The id of the block a block-item stack places, or '' (not a block item, unreadable).
function placedIdOf(stack) {
    if (!isBlockItemStack(stack)) return ''
    try {
        return '' + Block.getId(stack.getItem().getBlock())
    } catch (ignored) {
        try {
            return '' + stack.id
        } catch (ignored2) {
            return ''
        }
    }
}

// Containers, and block placing (the PRIMARY gate for placing).
//
// BlockEvents.rightClicked is NeoForge's PlayerInteractEvent.RightClickBlock, posted
// once per hand with that hand's stack as event.item, so "is the player placing a
// block" is exact here. Cancelling denies the interaction server-side: nothing is
// placed, nothing is consumed. (On 1.20.1 the placement cancel sat inside a try,
// which caught the exit and un-cancelled it -- the likely real cause of the
// "inconsistent" placement denial recorded then.)
//
// Refused through hasEffect(), which checks liberation. The 1.20.1 handler read the
// realm's effects directly and so still refused a LIBERATED animal-born player.
BlockEvents.rightClicked(event => {
    const player = event.player
    if (!player) return

    // 1. Containers and workstations: refuse opening them at all.
    if (hasEffect(player, 'noContainers')) {
        var id = ''
        try {
            id = '' + event.block.id
        } catch (ignored) {
            id = ''
        }
        if (id && isContainerBlock(id)) {
            refuse(player, 'An animal cannot work that.')
            event.cancel()
        }
    }

    // 2. Block placing: refuse when the item in THIS hand is a block. Food, tools,
    //    weapons and buckets stay usable, so an animal can still eat, dig and fight.
    //    (Holding a block also means doors and levers cannot be worked with that hand.)
    if (hasEffect(player, 'noBlockPlacing') && isBlockItemStack(event.item)) {
        refuse(player, 'An animal cannot place blocks.')
        event.cancel()
    }
})

// SECOND LINE OF DEFENCE for placing: refuse a placement the interaction gate missed.
//
// On KubeJS 7 this is NeoForge's BlockEvent.EntityPlaceEvent, and cancelling it makes
// CommonHooks.onPlaceItemIntoWorld restore the block snapshot AND leave the item stack
// at its pre-use count -- a clean refusal with the refund built in, safe in creative
// (read from the jar). On 1.20.1 it was a notification only, which is why the old
// version reverted to air and could not refund.
//
// BUT NeoForge fires this event for EVERY block change made through an item's useOn,
// except buckets: a hoe's farmland, an axe's stripped log, a shovel's path, fire from
// flint and steel, a crop grown by bone meal. Refusing all of them would take an
// animal's tools away. So this refuses only a placement whose block a held block item
// actually places. (Wall variants -- a wall torch from a torch -- do not match here;
// the interaction gate above catches those.)
//
// event.entity is null for a dispenser and non-player for an enderman; hasEffect()
// returns false for both, so a machine's placement is never refused on a player's
// behalf.
BlockEvents.placed(event => {
    const player = event.entity
    if (!hasEffect(player, 'noBlockPlacing')) return

    var placedId = ''
    try {
        placedId = '' + event.block.id
    } catch (ignored) {
        return
    }
    var fromHeld = false
    try {
        fromHeld = placedIdOf(player.getMainHandItem()) === placedId
    } catch (ignored2) {
        fromHeld = false
    }
    if (!fromHeld) {
        try {
            fromHeld = placedIdOf(player.getOffhandItem()) === placedId
        } catch (ignored3) {
            fromHeld = false
        }
    }
    if (!fromHeld) return

    refuse(player, 'An animal cannot place blocks.')
    event.cancel()
})

// ---- Preta (hungry ghost) realm --------------------------------------------
//
// A huge belly and a pinhole mouth: food the preta eats for ITSELF barely registers.
// Once feeding others exists (design doc 7), giving food away will be the efficient
// way to eat, and generosity becomes the escape route rather than a side activity.
//
// TIMING (read from both jars, 2026-10-21 -- the 1.20.1 version never worked). KubeJS
// fires foodEaten at HEAD of LivingEntity.eat(), but Player.eat() calls
// getFoodData().eat(food) FIRST and only then super.eat(). So for a PLAYER this
// handler sees the bar AFTER the meal. The 1.20.1 version took a "pre-meal" snapshot
// here, measured gained = 0 on the next tick and left through "no measurable gain":
// the multiplier never applied. The 3-icon cap landed the bar on 3 either way, which
// is what hid it.
//
// THE MEAL IS READABLE on 1.21.1: Item.finishUsingItem passes exactly
// stack.getFoodProperties(entity) to eat(), FoodProperties.nutrition() is a plain
// accessor, and the stack is not consumed until later in LivingEntity.eat(). So the
// correction is exact and immediate -- no queue, no cross-tick state, nothing that
// could land on the next body after a death.
//
// Writers of foodLevel, in tick order (the project notes: enumerate the writers before
// constraining a value): vanilla FoodData.tick (exhaustion and regen; the hunger
// effect adds exhaustion) -> vanilla FoodData.eat (the meal) -> THIS correction,
// inside the same eat() call -> the preta clamp below (every 4 ticks, DOWN only). The
// correction undoes what the meal did; the clamp then enforces the standing ceiling
// on the result. Because the correction runs inside eat(), that order is inherent,
// not a matter of handler registration -- and with no drain left for the clamp to
// eat, the 2026-10-18 "clamp swallows the drain" failure cannot recur.
ItemEvents.foodEaten(event => {
    // DIAGNOSTIC LOGGING (config.debugFood). Every exit path below is logged when it
    // is on, because every one of them is a SILENT return: the old version of this
    // hook failed completely and left no trace at all in the log, which is what made
    // it survive a full test round. Off by default -- it is one line per bite.
    var dbg = false
    try {
        dbg = global.SMS.config.debugFood === true
    } catch (ignored) {
        dbg = false
    }

    const player = event.entity
    if (!player || !player.isPlayer()) {
        if (dbg) console.info('[Samsara] foodEaten: entity is not a player; ignored')
        return
    }

    // Liberation turns realm penalties off. This handler cannot use hasEffect()
    // because foodMultiplier is a NUMBER, not a boolean flag, so it needs its own
    // guard -- the preta food penalty would otherwise outlive liberation.
    try {
        if (global.SMS.isLiberated(player)) {
            if (dbg) console.info('[Samsara] foodEaten: player is liberated; no penalty')
            return
        }
    } catch (ignored) {
        // fall through and apply normally
    }

    const realm = global.SMS.birthRealmOf(player)
    const fx = global.SMS.effectsFor(realm)
    const mult = fx.foodMultiplier
    if (mult === undefined || mult >= 1) {
        if (dbg) {
            console.info(
                `[Samsara] foodEaten: born-${realm} has no foodMultiplier (${mult}); full meal`
            )
        }
        return
    }

    // The bar as vanilla left it: ALREADY raised by this meal (see TIMING above).
    var cur = Number(player.foodLevel)
    if (!isFinite(cur)) {
        // The one failure that would be invisible AND fatal to the penalty, so it
        // warns even with the diagnostic off.
        console.warn('[Samsara] foodEaten: player.foodLevel unreadable; penalty skipped')
        return
    }

    // Saturation goes entirely, on every path below: a hungry ghost is never
    // satisfied. Done first so an early return cannot skip it.
    try {
        var sat = Number(player.saturation)
        if (isFinite(sat) && sat > 0) player.setSaturation(0)
    } catch (ignored) {
        // saturation unwritable; the food correction below still runs
    }

    // What this meal gave. Never silent on failure: the 1.20.1 hook's silent catch
    // hid an unreachable nutrition read for a whole test round.
    var nutrition = NaN
    try {
        nutrition = Number(event.item.getFoodProperties(player).nutrition())
    } catch (e) {
        console.warn(`[Samsara] foodEaten: meal nutrition unreadable; preta meal kept in full: ${e}`)
        return
    }
    if (!isFinite(nutrition) || nutrition <= 0) {
        if (dbg) console.info(`[Samsara] foodEaten: meal gives no nutrition (${nutrition}); saturation cleared only`)
        return
    }

    try {
        // Back out the meal, then keep the preta's share. `cur - nutrition` is exact
        // unless vanilla clamped the bar at 20 (pre + nutrition > 20); then it reads
        // LOW, which only ever costs the preta, never feeds it. A capped preta sits
        // at <= foodCap, so that needs a 15-point food.
        var pre = cur - nutrition
        if (pre < 0) pre = 0
        // FLOOR, not round, so the penalty can never round UP into a free point. A
        // meal worth less than 1/mult points therefore feeds a preta nothing at all,
        // which is the intent.
        var kept = Math.floor(nutrition * mult)
        var next = pre + kept
        if (next > cur) next = cur // never ADD food
        player.setFoodLevel(Math.floor(next))

        if (dbg) {
            console.info(
                `[Samsara] preta meal: ${player.profile.name} nutrition ${nutrition}` +
                    ` -> kept ${kept} (mult ${mult}); food ${cur} -> ${Math.floor(next)}`
            )
        }
    } catch (e) {
        console.warn(`[Samsara] foodEaten: preta correction failed: ${e}`)
    }
})

// ---- The preta tick: the clamp ----------------------------------------------
//
// Only the clamp runs on the tick now: the meal itself is corrected inside foodEaten.
ServerEvents.tick(event => {
    global.SMS.pretaCounter++
    if (global.SMS.pretaCounter >= PRETA_INTERVAL_TICKS) {
        global.SMS.pretaCounter = 0
        global.SMS.enforcePretaHunger(event.server)
    }
})

// ---- Preta: a capped hunger bar and a permanent hunger effect ----------------
//
// The design: a hungry ghost's bar never rises past `foodCap` (3 icons = 6 points)
// and they carry minecraft:hunger permanently. Together with foodMultiplier above,
// eating is close to pointless for a preta -- which is the realm's whole character.
//
// WHY A CEILING ON A TIMER, NOT A ONE-SHOT SET. Setting foodLevel once at rebirth
// does nothing lasting: the next meal refills the bar, and vanilla's own regen and
// the respawn both reset it to 20. The cap therefore has to be re-enforced. It runs
// on a timer rather than every tick because it is a clamp, not a reaction -- there is
// nothing to miss by checking 5x/second instead of 20x.
//
// WHY /effect AND NOT getPotionEffects().add(). Jar-verified 2026-10-18 on KubeJS 6:
// EntityPotionEffectsJS.add's overloads all take a net.minecraft MobEffect OBJECT
// ((Lnet/minecraft/world/effect/MobEffect;IIZZ)V and friends) -- there is NO
// String-id overload, and BuiltinKubeJSPlugin registered NO MobEffect type wrapper,
// so Rhino had nothing to coerce 'minecraft:hunger' with. That is project trap 8
// (overloads must match exactly) and it fails silently. runCommandSilent takes a
// plain String on KubeJS 6 and 7 alike, and /effect's syntax is unchanged in 1.21.1,
// so the command stays the seam.
//
// NOTE the /effect command takes SECONDS, while the config carries TICKS (every other
// duration in this pack is in ticks, and mixing the two units is how this goes wrong
// silently). The conversion happens here, once.
global.SMS.enforcePretaHunger = server => {
    var players = null
    try {
        players = server.players
    } catch (ignored) {
        return
    }
    if (!players) return

    var size = 0
    try {
        size = players.size()
    } catch (ignored) {
        return
    }
    if (size === 0) return

    for (var i = 0; i < size; i++) {
        var player = null
        try {
            player = players.get(i)
        } catch (ignored) {
            continue
        }
        if (!player) continue

        // Liberation turns realm penalties off. foodCap and hungerEffect are a number
        // and an object, not boolean flags, so hasEffect() does not cover them and
        // they need the same explicit guard the food multiplier does.
        var freed = false
        try {
            freed = global.SMS.isLiberated(player)
        } catch (ignored) {
            freed = false
        }
        if (freed) continue

        var fx = null
        try {
            fx = global.SMS.effectsFor(global.SMS.birthRealmOf(player))
        } catch (ignored) {
            continue
        }
        if (!fx) continue

        // 1. Clamp the hunger bar DOWN to the cap. Never raises it: a starving preta
        //    who has fallen below the cap stays where they are.
        if (fx.foodCap !== undefined) {
            try {
                var cur2 = Number(player.foodLevel)
                if (isFinite(cur2) && cur2 > fx.foodCap) {
                    player.setFoodLevel(Math.floor(fx.foodCap))
                    // Saturation above the cap would refill the bar straight back up,
                    // so it goes too -- vanilla drains saturation before food.
                    var sat2 = Number(player.saturation)
                    if (isFinite(sat2) && sat2 > 0) player.setSaturation(0)
                }
            } catch (ignored) {
                // food members unreadable; skip this player this pass
            }
        }

        // 2. Renew the hunger effect before it lapses, so the icon never flickers.
        if (fx.hungerEffect) {
            try {
                var he = fx.hungerEffect
                var seconds = Math.ceil(Number(he.durationTicks) / 20)
                if (!isFinite(seconds) || seconds < 1) seconds = 1
                var amp = Number(he.amplifier)
                if (!isFinite(amp) || amp < 0) amp = 0
                // `true` is hideParticles: a permanent effect should not fog the
                // screen with particles forever.
                player.runCommandSilent(
                    'effect give @s ' + he.id + ' ' + seconds + ' ' + amp + ' true'
                )
            } catch (ignored) {
                // command seam unavailable; nothing else to try
            }
        }
    }
}

// SECOND LINE OF DEFENCE FOR CONTAINERS.
//
// BlockEvents.rightClicked is the only cancellable hook for opening a container. Any
// menu that still opens -- a container reached some other way, a modded block whose
// id the suffix list misses -- is shut here.
//
// PlayerEvents.inventoryOpened is not cancellable (NeoForge PlayerContainerEvent.Open,
// both jars). But closeMenu IS reachable: PlayerMixin remaps closeContainer ->
// closeMenu on KubeJS 6 and 7. The player may see a single frame of the GUI, which is
// acceptable for a restriction that must hold.

// The player's own inventory menu. Loaded once; null if it cannot be loaded, in which
// case the guard below fails OPEN rather than risk locking a player out.
var InventoryMenuClass = null
try {
    InventoryMenuClass = Java.loadClass('net.minecraft.world.inventory.InventoryMenu')
} catch (e) {
    console.warn(`[Samsara] could not load InventoryMenu; the container backstop is off: ${e}`)
}

PlayerEvents.inventoryOpened(event => {
    const player = event.entity
    if (!player) return
    if (!hasEffect(player, 'noContainers')) return

    // The player's OWN inventory must stay usable -- an animal still carries items.
    // (The server never sends an "open" for it, so this is belt and braces.) Tested
    // with instanceof against the vanilla class: the 1.20.1 test read the class NAME
    // through getClass(), which KubeJS's class filter may not allow.
    var menu = null
    try {
        menu = event.inventoryContainer
        if (!menu || !InventoryMenuClass || menu instanceof InventoryMenuClass) return
    } catch (ignored) {
        // cannot identify the menu -- do nothing rather than risk locking a player
        // out of their own inventory.
        return
    }

    try {
        player.closeMenu()
        refuse(player, 'An animal cannot work that.')
    } catch (e) {
        // closeMenu unavailable: the rightClicked cancel is the only protection.
    }
})

console.info('[Samsara] realm effects registered')
