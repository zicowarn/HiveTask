fn main() {
    // The app icon is baked into the binary at compile time: on macOS dev
    // builds tauri-codegen embeds icons/icon.icns and the runtime applies it
    // as the Dock icon (setApplicationIconImage). tauri-build only tracks
    // src/, resources, capabilities and the tauri config — so editing the
    // icon files alone changes no tracked input, cargo skips the rebuild, and
    // the app keeps showing the previously embedded (stale) icon.
    //
    // Declaring the icons here makes an icon edit actually trigger a rebuild.
    println!("cargo:rerun-if-changed=icons");
    for icon in [
        "icons/icon.icns",
        "icons/icon.ico",
        "icons/icon.png",
        "icons/32x32.png",
        "icons/128x128.png",
        "icons/128x128@2x.png",
    ] {
        println!("cargo:rerun-if-changed={icon}");
    }

    tauri_build::build()
}
