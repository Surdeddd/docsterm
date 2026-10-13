use std::io::Read;

fn main() {
    let mut text = String::new();
    std::io::stdin().read_to_string(&mut text).unwrap();
    println!("read {} bytes: {}", text.len(), text.trim_end());
}
