use std::thread;
use std::time::{Duration, Instant};

fn main() {
    println!("before sleep");
    let start = Instant::now();
    thread::sleep(Duration::from_millis(10));
    let slept = start.elapsed() >= Duration::from_millis(10);
    println!("after sleep: {}", if slept { "ok" } else { "too short" });
}
