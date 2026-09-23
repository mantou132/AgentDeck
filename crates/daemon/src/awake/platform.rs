#[cfg(target_os = "macos")]
mod native {
    use anyhow::{Result, bail, ensure};
    use std::{
        ffi::{c_char, c_void},
        ptr,
    };
    type CF = *const c_void;
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFStringCreateWithCString(allocator: CF, text: *const c_char, encoding: u32) -> CF;
        fn CFRelease(value: CF);
        fn CFEqual(a: CF, b: CF) -> u8;
    }
    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        fn IOPSCopyPowerSourcesInfo() -> CF;
        fn IOPSGetProvidingPowerSourceType(info: CF) -> CF;
    }
    pub fn plugged() -> Result<bool> {
        unsafe {
            let info = IOPSCopyPowerSourcesInfo();
            ensure!(!info.is_null(), "Cannot read power sources");
            let source = IOPSGetProvidingPowerSourceType(info);
            if source.is_null() {
                CFRelease(info);
                bail!("Power source unavailable");
            }
            let ac = CFStringCreateWithCString(ptr::null(), c"AC Power".as_ptr(), 0x08000100);
            let result = CFEqual(source, ac) != 0;
            CFRelease(ac);
            CFRelease(info);
            Ok(result)
        }
    }
}
#[cfg(target_os = "windows")]
mod native {
    use anyhow::{Result, ensure};
    #[repr(C)]
    struct PowerStatus {
        ac: u8,
        flags: u8,
        percent: u8,
        status: u8,
        lifetime: u32,
        full_lifetime: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetSystemPowerStatus(status: *mut PowerStatus) -> i32;
    }
    pub fn plugged() -> Result<bool> {
        let mut status = PowerStatus {
            ac: 255,
            flags: 0,
            percent: 0,
            status: 0,
            lifetime: 0,
            full_lifetime: 0,
        };
        ensure!(
            unsafe { GetSystemPowerStatus(&mut status) } != 0,
            "Cannot read power status: {}",
            std::io::Error::last_os_error()
        );
        ensure!(status.ac != 255, "Power source unavailable");
        Ok(status.ac == 1)
    }
}
#[cfg(target_os = "linux")]
mod native {
    use anyhow::Result;
    pub fn plugged() -> Result<bool> {
        let mut battery = false;
        for entry in std::fs::read_dir("/sys/class/power_supply")? {
            let path = entry?.path();
            if path.join("scope").exists()
                && std::fs::read_to_string(path.join("scope"))?.trim() == "Device"
            {
                continue;
            }
            let kind = std::fs::read_to_string(path.join("type"))?;
            if kind.trim() == "Battery" {
                battery = true;
            }
            if path.join("online").exists()
                && std::fs::read_to_string(path.join("online"))?.trim() == "1"
            {
                return Ok(true);
            }
        }
        // Desktops without battery devices run on external power.
        Ok(!battery)
    }
}
#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
mod native {
    use anyhow::{Result, bail};
    pub fn plugged() -> Result<bool> {
        bail!("Power detection is unsupported on this platform")
    }
}
pub(super) use native::plugged;
