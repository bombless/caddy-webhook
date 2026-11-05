typedef unsigned int u32;
typedef unsigned char u8;

#define W 160
#define H 120
#define CELL 8
#define GW (W / CELL)
#define GH (H / CELL)
#define MAX_SNAKE 180
#define FRAME_BYTES (W * H * 4)

static u8 framebuffer[FRAME_BYTES];
static u8 config_buf[1024];
static u8 input_buf[1024];
static int sx[MAX_SNAKE], sy[MAX_SNAKE];
static int length, dx, dy, food_x, food_y, ticks, score, over, paused;
static u32 random_state = 0xB04B1E55u;

/* Tiny freestanding memmove used by LLVM's loop-idiom optimization. */
void *memmove(void *dst, const void *src, u32 n) {
  u8 *d=(u8 *)dst; const u8 *s=(const u8 *)src;
  if(d<s) for(u32 i=0;i<n;i++) d[i]=s[i];
  else if(d>s) for(u32 i=n;i>0;i--) d[i-1]=s[i-1];
  return dst;
}

static int contains(const u8 *p, u32 n, const char *s) {
  u32 i = 0, j;
  while (s[i]) i++;
  if (i > n) return 0;
  for (u32 k = 0; k + i <= n; k++) {
    for (j = 0; j < i && p[k+j] == (u8)s[j]; j++) {}
    if (j == i) return 1;
  }
  return 0;
}
static u32 rnd(void) {
  random_state = random_state * 1664525u + 1013904223u;
  return random_state;
}
static int occupied(int x, int y) {
  for (int i = 0; i < length; i++) if (sx[i] == x && sy[i] == y) return 1;
  return 0;
}
static void place_food(void) {
  for (int tries = 0; tries < 512; tries++) {
    int x = (int)(rnd() % GW), y = (int)(rnd() % GH);
    if (!occupied(x,y)) { food_x=x; food_y=y; return; }
  }
  over = 1;
}
static void reset_game(void) {
  length=4; sx[0]=10; sy[0]=7; sx[1]=9; sy[1]=7; sx[2]=8; sy[2]=7; sx[3]=7; sy[3]=7;
  dx=1; dy=0; ticks=0; score=0; over=0; paused=0; random_state=0xB04B1E55u; place_food();
}
static void pixel(int x, int y, u8 r, u8 g, u8 b) {
  if (x<0 || y<0 || x>=W || y>=H) return;
  u32 i=((u32)y*W+(u32)x)*4;
  framebuffer[i]=r; framebuffer[i+1]=g; framebuffer[i+2]=b; framebuffer[i+3]=255;
}
static void rect(int x, int y, int w, int h, u8 r, u8 g, u8 b) {
  for(int yy=y;yy<y+h;yy++) for(int xx=x;xx<x+w;xx++) pixel(xx,yy,r,g,b);
}
static void digit(int x, int y, int n) {
  static const u8 bits[10][5]={
    {7,5,5,5,7},{2,6,2,2,7},{7,1,7,4,7},{7,1,7,1,7},{5,5,7,1,1},
    {7,4,7,1,7},{7,4,7,5,7},{7,1,1,1,1},{7,5,7,5,7},{7,5,7,1,7}
  };
  for(int yy=0;yy<5;yy++) for(int xx=0;xx<3;xx++)
    if(bits[n%10][yy]&(1u<<(2-xx))) rect(x+xx*2,y+yy*2,2,2,210,226,235);
}
__attribute__((export_name("game_abi_version"))) u32 game_abi_version(void){return 1;}
__attribute__((export_name("game_init"))) int game_init(u32 ptr,u32 len){(void)ptr;(void)len;reset_game();return 0;}
__attribute__((export_name("game_update"))) int game_update(u32 dt){
  if(over||paused)return 0;
  ticks+=(int)dt;
  while(ticks>=120000 && !over){
    ticks-=120000;
    int nx=sx[0]+dx, ny=sy[0]+dy;
    if(nx<0||ny<0||nx>=GW||ny>=GH){over=1;break;}
    int eating=(nx==food_x&&ny==food_y);
    int limit=length-(eating?0:1);
    for(int i=0;i<limit;i++) if(sx[i]==nx&&sy[i]==ny){over=1;break;}
    if(over)break;
    if(eating && length<MAX_SNAKE) length++;
    for(int i=length-1;i>0;i--){sx[i]=sx[i-1];sy[i]=sy[i-1];}
    sx[0]=nx;sy[0]=ny;
    if(eating){score++;place_food();}
  }
  return 0;
}
__attribute__((export_name("game_input"))) int game_input(u32 ptr,u32 len){
  if(over||ptr!=(u32)(unsigned long)input_buf||len>sizeof(input_buf)) return 0;
  const u8 *event=(const u8 *)(unsigned long)ptr;
  if(!contains(event,len,"KEY_DOWN")) return 0;
  if(contains(event,len,"KeyP")||contains(event,len,"Pause")){paused=!paused;return 0;}
  if(paused)return 0;
  int ndx=dx,ndy=dy;
  if(contains(event,len,"ArrowUp")||contains(event,len,"KeyW")){ndx=0;ndy=-1;}
  else if(contains(event,len,"ArrowDown")||contains(event,len,"KeyS")){ndx=0;ndy=1;}
  else if(contains(event,len,"ArrowLeft")||contains(event,len,"KeyA")){ndx=-1;ndy=0;}
  else if(contains(event,len,"ArrowRight")||contains(event,len,"KeyD")){ndx=1;ndy=0;}
  if(ndx!=-dx||ndy!=-dy){dx=ndx;dy=ndy;}
  return 0;
}
__attribute__((export_name("game_render"))) int game_render(u32 ptr,u32 cap){
  if(ptr!=(u32)(unsigned long)framebuffer||cap<FRAME_BYTES)return -3;
  rect(0,0,W,H,10,18,27);
  for(int x=0;x<=W;x+=CELL) for(int y=0;y<H;y++) pixel(x,y,19,31,41);
  for(int y=0;y<=H;y+=CELL) for(int x=0;x<W;x++) pixel(x,y,19,31,41);
  rect(food_x*CELL+2,food_y*CELL+2,4,4,255,111,97);
  for(int i=length-1;i>=0;i--){
    u8 r=i?48:111, g=i?194:238, b=i?145:174;
    rect(sx[i]*CELL+1,sy[i]*CELL+1,CELL-2,CELL-2,r,g,b);
  }
  digit(5,5,score/100);digit(13,5,(score/10)%10);digit(21,5,score%10);
  if(paused){
    rect(68,48,24,24,31,48,62);
    rect(74,54,4,12,238,174,111);
    rect(82,54,4,12,238,174,111);
  }
  if(over){
    rect(36,52,88,16,31,48,62);
    rect(42,58,4,4,255,111,97);
    rect(50,58,4,4,255,111,97);
    rect(58,58,4,4,255,111,97);
    rect(66,58,4,4,255,111,97);
    rect(74,58,4,4,255,111,97);
    rect(82,58,4,4,255,111,97);
    rect(90,58,4,4,255,111,97);
    rect(98,58,4,4,255,111,97);
  }
  return FRAME_BYTES;
}
__attribute__((export_name("game_shutdown"))) void game_shutdown(void){}
__attribute__((export_name("game_get_width"))) u32 game_get_width(void){return W;}
__attribute__((export_name("game_get_height"))) u32 game_get_height(void){return H;}
__attribute__((export_name("game_get_render_buffer_ptr"))) u32 game_get_render_buffer_ptr(void){return (u32)(unsigned long)framebuffer;}
__attribute__((export_name("game_get_render_buffer_len"))) u32 game_get_render_buffer_len(void){return FRAME_BYTES;}
__attribute__((export_name("game_get_config_buffer_ptr"))) u32 game_get_config_buffer_ptr(void){return (u32)(unsigned long)config_buf;}
__attribute__((export_name("game_get_config_buffer_capacity"))) u32 game_get_config_buffer_capacity(void){return sizeof(config_buf);}
__attribute__((export_name("game_get_input_buffer_ptr"))) u32 game_get_input_buffer_ptr(void){return (u32)(unsigned long)input_buf;}
__attribute__((export_name("game_get_input_buffer_capacity"))) u32 game_get_input_buffer_capacity(void){return sizeof(input_buf);}
