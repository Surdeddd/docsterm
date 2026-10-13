use std::process::ExitCode;

fn main() -> ExitCode {
    match std::fs::read_to_string("notes.txt") {
        Ok(text) => {
            print!("{text}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("fs: cannot read notes.txt: {error}");
            ExitCode::from(2)
        }
    }
}
