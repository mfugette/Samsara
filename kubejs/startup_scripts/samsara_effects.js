// Samsara — the Hungry Ghost effect (samsara:hungry_ghost), the one effect a preta wears.
//
// Decided 2026-10-22 (the user) in place of Corail Tombstone's Ghostly Shape. That effect
// is a respawn grace: once a second its tick refills the food bar, zeroes exhaustion,
// heals and clears every harmful effect (read from tombstone-neoforge-1.21.1-9.5.6) --
// it would have undone the very hunger a preta is. This one does nothing on its own: it
// is the preta life's visible clock (its timer is the time left -- samsara_realms.js gives
// it from nbt.pretaLife) and it carries the life's weight. What a ghost IS -- nothing
// harms it, nothing hunts it -- is Samsara's realm rules, which follow birthRealm, not
// this effect.
//
// From the installed KubeJS 7 jar (build 377): BuiltinKubeJSPlugin registers a default
// builder for Registries.MOB_EFFECT (MobEffectBuilder). It starts NEUTRAL (so nothing that
// cleanses harmful effects -- Tombstone's clearBadEffects among them -- ever strips it),
// with no tick callback, and with no display name its lang entry is the id path in title
// case ("Hungry Ghost"). modifyAttribute(attribute, modifier id, amount, operation) is
// applied when the effect object is created.
//
// The two modifiers are vanilla Slowness I and Weakness I exactly, read from the 1.21.1
// MobEffects: generic.movement_speed -0.15 ADD_MULTIPLIED_TOTAL, generic.attack_damage
// -4.0 ADD_VALUE (1.21.1 attribute ids still carry the "generic." prefix).
//
// The icon is kubejs/assets/samsara/textures/mob_effect/hungry_ghost.png.
//
// Startup scripts run ONCE, at game launch: adding or editing this file needs a game
// restart, not /reload.

const ResourceLocationClass = Java.loadClass('net.minecraft.resources.ResourceLocation')
const OperationClass = Java.loadClass('net.minecraft.world.entity.ai.attributes.AttributeModifier$Operation')

StartupEvents.registry('mob_effect', event => {
    event
        .create('samsara:hungry_ghost')
        .modifyAttribute(
            ResourceLocationClass.parse('minecraft:generic.movement_speed'),
            ResourceLocationClass.parse('samsara:hungry_ghost_slowness'),
            -0.15,
            OperationClass.ADD_MULTIPLIED_TOTAL
        )
        .modifyAttribute(
            ResourceLocationClass.parse('minecraft:generic.attack_damage'),
            ResourceLocationClass.parse('samsara:hungry_ghost_weakness'),
            -4.0,
            OperationClass.ADD_VALUE
        )
})
