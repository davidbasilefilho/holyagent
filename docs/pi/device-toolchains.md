# Device Simulator toolchains

Run `holyagent setup pi --no-tui --device-access on` from a local graphical terminal to prepare T3 Code's Device Simulator. Run the same command with `--dry-run` to preview what setup would do. Preview doesn't run toolchain commands, and `--non-interactive` never runs an installer. Setup respects T3 Code's existing device settings and reports when it can't verify a simulator instead of treating an installed SDK as ready.

## Android on Windows, macOS and Linux

Setup looks for an existing SDK at `ANDROID_HOME`, then `ANDROID_SDK_ROOT`, then the platform's standard Android Studio SDK location. Use Android Studio's setup wizard if you don't have an SDK yet. Check Google's supported host requirements before installing, especially on Windows or Linux ARM. [Install Android Studio](https://developer.android.com/studio/install)

On a supported host, setup can request missing `platform-tools` and `emulator` packages from an installed Google Android CLI or SDK Command-line Tools when the SDK is writable and has an existing license record. Google's installer makes the final licensing decision. HolyAgent doesn't accept licenses, run a bootstrap installer, add custom repositories, update existing packages, or escalate privileges. If it reports a package license or Java problem, use Android Studio's SDK Manager to review the license, or configure a compatible JDK with `JAVA_HOME` for `sdkmanager`. [Android CLI SDK install](https://developer.android.com/tools/agents/android-cli/commands/sdk_install) · [SDK Command-line Tools](https://developer.android.com/tools/sdkmanager) · [Android build JDKs](https://developer.android.com/build/jdks)

Create an Android Virtual Device and download its system image in Android Studio's Device Manager. Setup checks that it can find the AVD and its image and that the emulator reports usable hardware acceleration. It doesn't create an AVD, configure a hypervisor, or boot the emulator. If the check fails, follow Google's host-specific steps for WHPX on Windows, Hypervisor.Framework on macOS, or KVM on Linux. [Create an AVD](https://developer.android.com/studio/run/managing-avds) · [Configure emulator acceleration](https://developer.android.com/studio/run/emulator-acceleration)

## iOS on macOS

Install full Xcode, open it to complete first launch and review any license or administrator prompts, then install an iOS runtime from Xcode's Components settings. If you have more than one Xcode, choose the full installation in Xcode > Settings > Locations or set `DEVELOPER_DIR`. The standalone Command Line Tools aren't enough. Setup checks the selected Xcode and whether it reports an available iOS runtime. It won't sign in, download Xcode or a runtime, or boot a simulator. [Get Xcode](https://developer.apple.com/xcode/resources/) · [Install Xcode components](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components)
