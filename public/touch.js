// Decides whether the game runs with on-screen touch controls.
//
// Phones and iPads switch on straight away. Devices that have a touchscreen
// *and* a mouse or keyboard (Windows/Chromebook touch laptops, tablets with a
// trackpad) are ambiguous, so they follow the input the player used to press
// "Start": a finger turns touch controls on, a mouse or key leaves them off.
//
// Override with ?touch=1 (always on) or ?touch=0 (always off).
(() => {
    const params = new URLSearchParams(window.location.search);
    const forced = params.get('touch');

    const mobileUA = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
    // iPadOS 13+ asks for the desktop site by default and reports itself as a Mac.
    // A real Mac has no touchscreen, so touch points give it away.
    const iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;

    const primary = forced === '1' || (forced !== '0' && ((mobileUA && coarsePointer) || iPadOS));

    // 'touch' | 'mouse' | 'pen' | 'keyboard' | null
    let lastInput = null;
    let active = primary;

    const nativeRequestPointerLock = Element.prototype.requestPointerLock;

    function apply() {
        document.body.dataset.isTouch = active ? '1' : '0';
        // The engine asks for pointer lock once fullscreen. On touch that freezes
        // every pointer at 0,0, so drags measure zero and the sticks/menu swipes die.
        Element.prototype.requestPointerLock = active ? () => {} : nativeRequestPointerLock;
    }

    window.addEventListener('pointerdown', (event) => {
        lastInput = event.pointerType || lastInput;
    }, true);
    window.addEventListener('keydown', () => { lastInput = 'keyboard'; }, true);

    // Browser gestures that would fight the on-screen controls. touch-action in
    // the stylesheet covers most of this; these catch what it doesn't.
    // Pinch-zoom on iOS Safari:
    document.addEventListener('gesturestart', (event) => {
        if (active) event.preventDefault();
    }, { passive: false });
    // Long-press menu (Android/Windows) on the controls or the game:
    document.addEventListener('contextmenu', (event) => {
        if (active && event.target.closest?.('.touch-controls-wrapper, #canvas')) event.preventDefault();
    });

    window.vcTouch = {
        get active() { return active; },
        // True on devices that are touch-first (phones, iPads), false on hybrids.
        get primary() { return primary; },
        // Call when the player presses Start; settles hybrid devices.
        decide() {
            if (forced === '1') active = true;
            else if (forced === '0') active = false;
            else active = primary || lastInput === 'touch';
            apply();
            return active;
        },
    };

    apply();
})();
