import {MODERN_MCP_PROTOCOL_VERSION} from './modern-mcp-stdio.ts';

type MetadataError={code:number;message:string;data:Record<string,unknown>};
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);

/** Stateless request metadata, independent of browser execution. Kept outside
 * the legacy tool router so retiring that router cannot bypass the boundary. */
export function validateRequestMetadata(params:Record<string,unknown>|undefined):MetadataError|null{
  const metadata=object(params?._meta)?params._meta:{};
  const requested=metadata['io.modelcontextprotocol/protocolVersion'];
  if(typeof requested!=='string'||requested.length===0||requested.length>80)return {
    code:-32602,message:'Missing MCP protocol version metadata.',data:{errorCode:'protocol_version_required'},
  };
  if(requested!==MODERN_MCP_PROTOCOL_VERSION)return {
    code:-32022,message:'Unsupported MCP protocol version.',data:{supported:[MODERN_MCP_PROTOCOL_VERSION],requested},
  };
  if(!object(metadata['io.modelcontextprotocol/clientCapabilities']))return {
    code:-32602,message:'Missing MCP client capabilities metadata.',data:{errorCode:'client_capabilities_required'},
  };
  const client=metadata['io.modelcontextprotocol/clientInfo'];
  if(client!==undefined&&(!object(client)||typeof client.name!=='string'||client.name.length===0||client.name.length>240||typeof client.version!=='string'||client.version.length===0||client.version.length>120))return {
    code:-32602,message:'Invalid MCP client info metadata.',data:{errorCode:'invalid_client_info'},
  };
  return null;
}
