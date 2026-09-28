use anstyle::{AnsiColor, Color, Style};
use std::fmt;

pub const BOLD: Style = Style::new().bold();
pub const DIM: Style = Style::new().dimmed();
pub const UNDERLINE: Style = Style::new().underline();

pub const CYAN: Style = Style::new()
    .fg_color(Some(Color::Ansi(AnsiColor::Cyan)))
    .bold();
pub const GREEN: Style = Style::new()
    .fg_color(Some(Color::Ansi(AnsiColor::Green)))
    .bold();
pub const YELLOW: Style = Style::new().fg_color(Some(Color::Ansi(AnsiColor::Yellow)));
pub const RED: Style = Style::new()
    .fg_color(Some(Color::Ansi(AnsiColor::Red)))
    .bold();
pub const WARN: Style = Style::new()
    .fg_color(Some(Color::Ansi(AnsiColor::Yellow)))
    .bold();

/// Wrapper that applies a style and automatically resets it upon completion.
pub struct Styled<T> {
    value: T,
    style: Style,
}

impl<T: fmt::Display> fmt::Display for Styled<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}{}{}",
            self.style,
            self.value,
            self.style.render_reset()
        )
    }
}

pub fn bold<T: fmt::Display>(value: T) -> Styled<T> {
    Styled { value, style: BOLD }
}

pub fn dim<T: fmt::Display>(value: T) -> Styled<T> {
    Styled { value, style: DIM }
}

pub fn cyan<T: fmt::Display>(value: T) -> Styled<T> {
    Styled { value, style: CYAN }
}

pub fn green<T: fmt::Display>(value: T) -> Styled<T> {
    Styled {
        value,
        style: GREEN,
    }
}

pub fn yellow<T: fmt::Display>(value: T) -> Styled<T> {
    Styled {
        value,
        style: YELLOW,
    }
}

pub fn red<T: fmt::Display>(value: T) -> Styled<T> {
    Styled { value, style: RED }
}

pub fn underline<T: fmt::Display>(value: T) -> Styled<T> {
    Styled {
        value,
        style: UNDERLINE,
    }
}

pub fn warn<T: fmt::Display>(value: T) -> Styled<T> {
    Styled { value, style: WARN }
}

/// Print formatted "Label     : Value" with aligned bold label.
pub fn kv(label: &str, value: impl fmt::Display) {
    let padded = format!("{label:10}");
    anstream::println!("{}: {value}", bold(padded));
}

/// Print a green success checkmark item.
pub fn success(msg: impl fmt::Display) {
    anstream::println!("{} {msg}", green("✔"));
}

/// Print a bulleted notice item.
pub fn note(msg: impl fmt::Display) {
    anstream::println!("{} {msg}", yellow("●"));
}

/// Print the security warning box with prominent yellow border.
pub fn print_security_warning() {
    anstream::println!(
        "{}",
        warn("┌──────────────────────────────────────────────────────────────────────┐")
    );
    anstream::println!(
        "{}",
        warn("│ ⚠️  KEEP THIS SECRET: Anyone with this output can access your agent. │")
    );
    anstream::println!(
        "{}",
        warn("└──────────────────────────────────────────────────────────────────────┘")
    );
}
