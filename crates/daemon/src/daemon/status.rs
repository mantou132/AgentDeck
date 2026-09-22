use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Status {
    NotInstalled,
    Running,
    Stopped(Option<String>),
}

impl fmt::Display for Status {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Status::Running => write!(f, "running"),
            Status::Stopped(Some(reason)) => write!(f, "stopped ({reason})"),
            Status::Stopped(None) => write!(f, "stopped"),
            Status::NotInstalled => write!(f, "not installed"),
        }
    }
}

impl From<service_manager::ServiceStatus> for Status {
    fn from(s: service_manager::ServiceStatus) -> Self {
        match s {
            service_manager::ServiceStatus::NotInstalled => Status::NotInstalled,
            service_manager::ServiceStatus::Running => Status::Running,
            service_manager::ServiceStatus::Stopped(reason) => Status::Stopped(reason),
        }
    }
}
