// UI guidance only. Every write is independently authorized by the group host.
export function canInGroup(room,id,permission,channel=null){
  if(!room)return false;if(room.ownerId===id)return true;
  const membership=room.memberships?.[id],roles=(room.roles||[]).filter(r=>r.id==='member'||membership?.roleIds?.includes(r.id));
  if((membership?.timeoutUntil||0)>Date.now()&&['send','react','connect'].includes(permission))return false;
  if(roles.some(r=>r.id==='admin'))return true;
  let allowed=roles.some(r=>r.permissions?.includes(permission));
  if(channel&&['read','send','react','connect'].includes(permission))for(const role of[...roles].sort((a,b)=>a.position-b.position)){const value=channel.permissions?.[role.id]?.[permission];if(typeof value==='boolean')allowed=value;}
  return allowed;
}
export function memberDisplay(room,member){return room?.memberships?.[member.id]?.nickname||member.nickname||member.name;}
