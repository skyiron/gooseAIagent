use anyhow::Result;
use goose::agents::Agent;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};
use uuid::Uuid;

/// Shared application state
#[derive(Clone)]
pub struct AppState {
    /// Map of agent_id to Agent instance
    pub agents: Arc<RwLock<HashMap<String, Box<dyn Agent>>>>,
    /// Legacy single agent support - TODO: Remove once all routes updated
    pub agent: Arc<RwLock<Option<Box<dyn Agent>>>>,
    pub secret_key: String,
    pub config: Arc<Mutex<HashMap<String, Value>>>,
}

impl AppState {
    pub async fn new(secret_key: String) -> Result<Self> {
        Ok(Self {
            agents: Arc::new(RwLock::new(HashMap::new())),
            agent: Arc::new(RwLock::new(None)),
            secret_key,
            config: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// Store a new agent and return its ID
    pub async fn store_agent(&self, agent: Box<dyn Agent>) -> Result<String> {
        let agent_id = Uuid::new_v4().to_string();
        self.agents.write().await.insert(agent_id.clone(), agent);
        Ok(agent_id)
    }

    /// Get an agent by ID
    pub async fn get_agent(&self, agent_id: &str) -> Option<Box<dyn Agent>> {
        self.agents.read().await.get(agent_id).cloned()
    }

    /// Remove an agent by ID
    pub async fn remove_agent(&self, agent_id: &str) -> Option<Box<dyn Agent>> {
        self.agents.write().await.remove(agent_id)
    }
}