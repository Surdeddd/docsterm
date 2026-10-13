use std::process::ExitCode;

fn main() -> ExitCode {
    let words: Vec<String> = std::env::args().skip(1).collect();
    if words.is_empty() {
        eprintln!("greet: missing a name");
        return ExitCode::from(2);
    }
    println!("Hello, {}! This is Rust compiled to WebAssembly.", words.join(" "));
    ExitCode::SUCCESS
}
