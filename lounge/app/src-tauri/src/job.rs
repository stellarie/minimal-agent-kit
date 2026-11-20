#[cfg(windows)]
pub use windows_job::Job;

#[cfg(not(windows))]
pub struct Job;

#[cfg(not(windows))]
impl Job {
    pub fn new() -> std::io::Result<Self> {
        Ok(Self)
    }

    pub fn assign(&self, _child: &std::process::Child) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(windows)]
mod windows_job {
    use std::io;
    use std::mem;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use std::ptr;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// Kills members on last close.
    pub struct Job(HANDLE);

    // SAFETY: a job handle is a kernel object reference, not
    // thread-affine memory. The Win32 job functions may be called
    // with it from any thread, and `Job` never hands it out.
    unsafe impl Send for Job {}
    // SAFETY: `assign` only passes the handle to a thread-safe
    // kernel call; no method mutates `Job` through `&self`.
    unsafe impl Sync for Job {}

    impl Job {
        pub fn new() -> io::Result<Self> {
            // SAFETY: null attributes and a null name are documented
            // as valid; the call returns an owned handle or null.
            let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            let job = Self(handle);
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let size = u32::try_from(mem::size_of_val(&info))
                .map_err(|err| io::Error::new(io::ErrorKind::InvalidInput, err))?;
            // SAFETY: `job.0` is the live handle created above.
            // `info` is a valid, initialised value of the struct that
            // the class `JobObjectExtendedLimitInformation` expects,
            // and `size` is its exact size. The call only reads it.
            let set = unsafe {
                SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    ptr::from_ref(&info).cast(),
                    size,
                )
            };
            if set == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(job)
        }

        pub fn assign(&self, child: &Child) -> io::Result<()> {
            // SAFETY: `self.0` stays open until `Drop`. The process
            // handle belongs to `child`, which the borrow keeps alive
            // for the duration of the call.
            let assigned = unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle()) };
            if assigned == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: `self.0` is owned by this value and is closed
            // exactly once, here.
            unsafe { CloseHandle(self.0) };
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::Job;
    use crate::test_support::sleeper;
    use std::thread;
    use std::time::{Duration, Instant};

    #[test]
    fn closing_the_job_kills_the_child() {
        let job = Job::new().expect("job");
        let mut child = sleeper();
        job.assign(&child).expect("assign");
        drop(job);
        let deadline = Instant::now() + Duration::from_secs(10);
        while child.try_wait().expect("try_wait").is_none() {
            assert!(Instant::now() < deadline, "the child outlived the job");
            thread::sleep(Duration::from_millis(50));
        }
    }
}
