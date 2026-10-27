//! Programs C-Bot runs: without a console window flashing up (NoWindow), ended with
//! everything they started (kill_tree), or kept in a job object that ends everything in it
//! when it's closed (dropped, or C-Bot ends): a shell's whole process tree goes with its tab
//! (workbench/shell.rs).

use std::os::windows::process::CommandExt;
use std::process::{Child, Command, Stdio};

use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation, SetInformationJobObject,
};
use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Run it without a console window (a .cmd, git, Claude Code…).
pub trait NoWindow {
    fn no_window(&mut self) -> &mut Self;
}

impl NoWindow for Command {
    fn no_window(&mut self) -> &mut Self {
        self.creation_flags(CREATE_NO_WINDOW)
    }
}

/// Ends a process and everything it started. Only while its Child is still held: once that's
/// dropped, Windows may give the id to another program.
pub fn kill_tree(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/pid", &pid.to_string(), "/T", "/F"])
        .no_window()
        .output();
}

fn cmd_safe(s: &str) -> String {
    s.chars().filter(|c| !"\"%^&|<>".contains(*c)).collect()
}

/// The command line for cmd.exe: `start /WAIT` opens a fresh console window (Windows
/// Terminal, when that's the default terminal) and only returns when the program in it ends.
/// Arguments must be plain words: quotes and cmd's special characters are taken out.
pub fn terminal_line(title: &str, folder: &str, program: &str, args: &[String]) -> String {
    let args = if args.is_empty() {
        String::new()
    } else {
        format!(" {}", args.join(" "))
    };
    format!(
        "/d /s /c \"start \"{}\" /WAIT /D \"{}\" \"{}\"{}\"",
        cmd_safe(title),
        cmd_safe(folder),
        cmd_safe(program),
        args
    )
}

/// Run `program` in a terminal window of its own, in `folder`, with only `env`: the Child
/// (the launcher, itself out of sight) ends when that window closes.
pub fn in_terminal(
    title: &str,
    folder: &str,
    program: &str,
    args: &[String],
    env: Vec<(String, String)>,
) -> std::io::Result<Child> {
    let shell = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into());
    Command::new(shell)
        .raw_arg(terminal_line(title, folder, program, args))
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .no_window()
        .spawn()
}

pub struct Job(isize);

impl Job {
    pub fn new() -> Option<Job> {
        // SAFETY: a new job object (checked), set up with a zeroed limits struct of the right
        // size; closed again if that fails.
        unsafe {
            let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if h.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let size = std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
            if SetInformationJobObject(
                h,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                size,
            ) == 0
            {
                CloseHandle(h);
                return None;
            }
            Some(Job(h as isize))
        }
    }

    /// Put a running process in it (and so everything it starts after).
    pub fn take(&self, pid: u32) {
        // SAFETY: the process handle is checked and closed again; the job is ours.
        unsafe {
            let p = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if !p.is_null() {
                AssignProcessToJobObject(self.0 as _, p);
                CloseHandle(p);
            }
        }
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        // SAFETY: our own job handle, closed once.
        unsafe { CloseHandle(self.0 as _) };
    }
}
