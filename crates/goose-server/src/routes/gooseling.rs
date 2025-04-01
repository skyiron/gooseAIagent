use axum::{
    extract::State,
    routing::{post},
    Json, Router,
    http::{HeaderMap, StatusCode},
};
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
    gooseling.activities = request.activities;
    
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
/// need to fix this. it stalls in adding extensions.
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
    println!("creating agent");
    let response = crate::routes::agent::create_agent(State(state.clone()), headers.clone(), Json(create_request)).await?;

    // Get the version from the agent creation response
    let version = response.0.version;

    // Now configure the agent with extensions and goosehints
    let mut agent = state.agent.write().await;
    let agent = agent.as_mut().ok_or(StatusCode::PRECONDITION_REQUIRED)?;

    println!("Adding extensions: {:#?}", request.gooseling.extensions);
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

            // Add the extension using the extension routes
            crate::routes::extension::add_extension(
                State(state.clone()),
                headers.clone(),
                Json(ext_request),
            ).await?;
        }
    }

    println!("goosehints");
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