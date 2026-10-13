use std::io::Write;

fn main() {
    println!("step 1");
    eprintln!("warning: low disk");
    println!("step 2");
    print!("progress 50%");
    std::io::stdout().flush().unwrap();
    eprintln!("error: crashed");
    std::process::exit(1);
}
