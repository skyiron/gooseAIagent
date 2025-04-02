use axum::{
    extract::State,
    routing::{post},
    Json, Router,
    http::{HeaderMap, StatusCode},
};
use std::collections::HashMap;
use goose::agents::extension::Envs;
use goose::config::ExtensionConfig;
use goose::gooselings::Gooseling;
use goose::message::Message;
use serde::{Deserialize, Serialize};

use crate::{error::Error, state::AppState, routes::extension::ExtensionConfigRequest};

#[derive(Debug, Deserialize)]
pub struct CreateGooselingRequest {
    messages: Vec<Message>,
    // Required metadata
    title: String,
    description: String,
    // Optional fields
    #[serde(default)]
    activities: Option<Vec<String>>,
    #[serde(default)]
    author: Option<AuthorRequest>,
}

#[derive(Debug, Deserialize)]
pub struct AuthorRequest {
    #[serde(default)]
    contact: Option<String>,
    #[serde(default)]
    metadata: Option<String>,
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
#[axum::debug_handler]
async fn create_gooseling(
    State(state): State<AppState>,
    Json(request): Json<CreateGooselingRequest>,
) -> Result<Json<CreateGooselingResponse>, Error> {
    let agent = state.agent.read().await;
    let agent = agent.as_ref().ok_or(Error::NoAgent)?;
    
    // Create base gooseling from agent state and messages
    let mut gooseling = agent.create_gooseling(request.messages).await?;

    // Update with user-provided metadata
    gooseling.title = request.title;
    gooseling.description = request.description;
    if request.activities.is_some(){
        gooseling.activities = request.activities
    };
    
    // Add author if provided
    if let Some(author_req) = request.author {
        gooseling.author = Some(goose::gooselings::Author {
            contact: author_req.contact,
            metadata: author_req.metadata,
        });
    }

    Ok(Json(CreateGooselingResponse { gooseling }))
}

/// Load a Gooseling configuration and create a new agent from it
async fn load_gooseling(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<LoadGooselingRequest>,
) -> Result<Json<LoadGooselingResponse>, StatusCode> {
    // Verify the secret key is present
    if !headers.contains_key("X-Secret-Key") {
        return Err(StatusCode::UNAUTHORIZED);
    }
    
    // First create the agent using the agent creation handler
    let create_request = crate::routes::agent::CreateAgentRequest {
        version: request.version,
        provider: request.provider,
        model: request.model,
    };

    // Call the agent creation handler
    let response = match crate::routes::agent::create_agent(State(state.clone()), headers.clone(), Json(create_request)).await {
        Ok(resp) => resp,
        Err(e) => {
            eprintln!("Failed to create agent: {:?}", e);
            return Err(e);
        }
    };

    // Get the version from the agent creation response
    let version = response.0.version;

    // Now configure the agent with extensions and goosehints
    let mut agent_guard = state.agent.write().await;
    let agent = match agent_guard.as_mut() {
        Some(agent) => agent,
        None => return Err(StatusCode::PRECONDITION_REQUIRED),
    };

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
                    env_keys: envs.get_env().keys().cloned().collect(),
                    timeout,
                },
                goose::agents::extension::ExtensionConfig::Stdio { 
                    name, cmd, args, description: _, envs, timeout 
                } => ExtensionConfigRequest::Stdio {
                    name,
                    cmd,
                    args,
                    env_keys: envs.get_env().keys().cloned().collect(),
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

            // Convert back to ExtensionConfig with empty env vars since they're in the gooseling config
            let extension_config = match ext_request {
                ExtensionConfigRequest::Sse { 
                    name, uri, env_keys: _, timeout 
                } => ExtensionConfig::Sse {
                    name,
                    uri,
                    envs: Envs::new(HashMap::new()),
                    description: None,
                    timeout,
                },
                ExtensionConfigRequest::Stdio { 
                    name, cmd, args, env_keys: _, timeout 
                } => ExtensionConfig::Stdio {
                    name,
                    cmd,
                    args,
                    description: None,
                    envs: Envs::new(HashMap::new()),
                    timeout,
                },
                ExtensionConfigRequest::Builtin { 
                    name, display_name, timeout 
                } => ExtensionConfig::Builtin {
                    name,
                    display_name,
                    timeout,
                },
            };
            
            match crate::routes::extension::add_extension_internal(agent, extension_config).await {
                Ok(response) => {
                    if response.error {
                        eprintln!("Extension addition failed: {:?}", response.message);
                        return Err(StatusCode::INTERNAL_SERVER_ERROR);
                    }
                },
                Err(e) => {
                    eprintln!("Failed to add extension with error: {:?}", e);
                    return Err(e);
                }
            }
        }
    }

    // Add goosehints if provided
    if let Some(goosehints) = request.gooseling.goosehints {
        agent.extend_system_prompt(goosehints).await;
    }

    // Add context if provided
    if let Some(context) = request.gooseling.context {
        for ctx in context {
            agent.extend_system_prompt(ctx).await;
        }
    }

    // Return the LoadGooselingResponse with the version
    Ok(Json(LoadGooselingResponse { version }))
}

pub fn routes(state: AppState) -> Router {
    Router::new()
        .route("/api/gooseling/create", post(create_gooseling))
        .route("/api/gooseling/load", post(load_gooseling))
        .with_state(state)
}