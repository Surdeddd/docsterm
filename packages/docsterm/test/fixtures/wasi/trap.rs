use std::io::Write;

fn main() {
    print!("partial");
    std::io::stdout().flush().unwrap();
    core::arch::wasm32::unreachable()
}
