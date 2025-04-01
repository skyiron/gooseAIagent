use axum::{
    extract::State,
    routing::{post},
    Json, Router,
    http::{HeaderMap, StatusCode},
};
use goose::{agents::Agent, Gooseling};
use goose::message::Message;
use serde::{Deserialize, Serialize};

use crate::{error::Error, state::AppState, routes::extension::{ExtensionConfigRequest, ExtensionResponse}};

#[derive(Debug, Deserialize)]
pub struct CreateGooselingRequest {
    messages: Vec<Message>,
    // User provi}ded metadata
    title: String,
    description: String,
    #[serde(default)]
    activities: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
pub struct CreateGooselingResponse {
    gooseling: Gooseling,
}

#[derive(Debug, Deserialize)]
pub struct LoadGooselingRequest {
    gooseling: Gooseling,
    // Required fields for agent creation
    provider: String,
    model: Option<String>,
    version: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct LoadGooselingResponse {
    version: String,
}

/// Create a Gooseling configuration from the current state of an agent
async fn create_gooseling(
    State(state): State<AppState>,
    Json(request): Json<CreateGooselingRequest>,
) -> Result<Json<CreateGooselingResponse>, Error> {
    
    mut gooseling = state.agent.create_gooseling(request.messages);

    gooseling.title = request.title;
    gooseling.description = request.description;

    if request.activities.is_some() {
        gooseling.activities = request.activities;
    }
    
    // Create a Gooseling using the builder pattern
    let gooseling = Gooseling {
        version: "1.0.0".to_string(),
        title: request.title,
        description: request.description,
        instructions: agent.get_instructions().to_string(),
        extensions: Some(agent.get_extensions().clone()),
        goosehints: None, // Could be added from agent state if needed
        context: None, // Could include message history if needed
        activities: request.activities,
        author: if request.author_contact.is_some() || request.author_metadata.is_some() {
            Some(goose::Author {
                contact: request.author_contact,
                metadata: request.author_metadata,
            })
        } else {
            None
        },
    };

    Ok(Json(CreateGooselingResponse { gooseling }))
}

/// Load a Gooseling configuration and create a new agent from it
async fn load_gooseling(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<LoadGooselingRequest>,
) -> Result<Json<LoadGooselingResponse>, StatusCode> {
    // First create the agent using the agent creation handler
    let create_request = crate::routes::agent::CreateAgentRequest {
        version: request.version,
        provider: request.provider,
        model: request.model,
    };

    // Call the agent creation handler
    let response = crate::routes::agent::create_agent(State(state.clone()), headers.clone(), Json(create_request)).await?;

    // Now configure the agent with extensions and goosehints
    let mut agent = state.agent.write().await;
    let agent = agent.as_mut().ok_or(StatusCode::PRECONDITION_REQUIRED)?;

    // Add extensions if provided
    if let Some(extensions) = request.gooseling.extensions {
        for ext_config in extensions {
            // Convert ExtensionConfig to ExtensionConfigRequest
            let ext_request = match ext_config {
                goose::agents::extension::ExtensionConfig::Sse { 
                    name, uri, envs, description: _, timeout 
                } => ExtensionConfigRequest::Sse {
                    name,
                    uri,
                    env_keys: envs.into_keys().collect(),
                    timeout,
                },
                goose::agents::extension::ExtensionConfig::Stdio { 
                    name, cmd, args, description: _, envs, timeout 
                } => ExtensionConfigRequest::Stdio {
                    name,
                    cmd,
                    args,
                    env_keys: envs.into_keys().collect(),
                    timeout,
                },
                goose::agents::extension::ExtensionConfig::Builtin { 
                    name, display_name, timeout 
                } => ExtensionConfigRequest::Builtin {
                    name,
                    display_name,
                    timeout,
                },
            };

            // Add the extension using the extension routes
            crate::routes::extension::add_extension(
                State(state.clone()),
                headers.clone(),
                Json(ext_request),
            ).await?;
        }
    }

    // Add goosehints if provided
    if let Some(goosehints) = request.gooseling.goosehints {
        agent.extend_system_prompt(goosehints).await;
    }

    Ok(response)
}

pub fn routes(state: AppState) -> Router {
    Router::new()
        .route("/api/gooseling/create", post(create_gooseling))
        .route("/api/gooseling/load", post(load_gooseling))
        .with_state(state)
}