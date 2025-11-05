// Build script - only needed for NAPI bindings
// For the standalone server binary, no build script is needed

fn main() {
    // When building the server binary with --no-default-features,
    // this build script does nothing (NAPI is not enabled)

    #[cfg(feature = "napi-bindings")]
    {
        // NAPI bindings are enabled, but we've removed the dependency
        // to avoid the build error. If you need NAPI bindings, install them separately.
        println!("cargo:warning=NAPI bindings require napi-build dependency");
    }
}
