#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <bcrypt.h>
#include <shellapi.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <cstdio>
#include <deque>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

#pragma comment(lib, "Ws2_32.lib")
#pragma comment(lib, "Bcrypt.lib")
#pragma comment(lib, "Advapi32.lib")

namespace relay {
using Bytes = std::vector<std::uint8_t>;
constexpr std::uint32_t kMagic = 0x43505232; // CPR2
constexpr std::uint8_t kVersion = 2;
constexpr std::uint32_t kMaxPayload = 65536;
constexpr std::size_t kWindow = 256 * 1024, kChunk = 16 * 1024, kSessionBudget = 32 * 1024 * 1024;
constexpr DWORD kPublicSendTimeoutMs = 120000;
constexpr wchar_t kServiceName[] = L"CodexPhoneRelay";

enum class Type : std::uint8_t { Hello=1, Challenge=2, Auth=3, AuthOk=4, Open=5, OpenOk=6, Data=7, Close=8, Ping=9, Pong=10, Error=11, Credit=12, Fin=13 };

struct Config {
    std::string publicBind = "0.0.0.0";
    std::uint16_t publicPort = 8788;
    std::string agentBind = "0.0.0.0";
    std::uint16_t agentPort = 8789;
    std::string secret;
    std::size_t maxClients = 128;
    std::filesystem::path logFile = L"relay-server.log";
};

class Logger {
    std::mutex mutex_;
    std::ofstream file_;
public:
    void open(const std::filesystem::path& path) { if(path.empty())return;std::error_code ec;if(std::filesystem::file_size(path,ec)>5*1024*1024){auto old=path;old+=L".1";std::filesystem::remove(old,ec);std::filesystem::rename(path,old,ec);}file_.open(path,std::ios::app); }
    void write(std::string_view level, std::string_view message) {
        const auto now = std::chrono::system_clock::now();
        const auto t = std::chrono::system_clock::to_time_t(now);
        std::tm tm{}; localtime_s(&tm, &t);
        std::ostringstream line; line << std::put_time(&tm, "%Y-%m-%d %H:%M:%S") << " [" << level << "] " << message << '\n';
        std::lock_guard lock(mutex_); std::cout << line.str(); std::cout.flush();
        if (file_) { file_ << line.str(); file_.flush(); }
    }
};
Logger gLog;

std::string trim(std::string s) {
    const auto first=s.find_first_not_of(" \t\r\n"); if(first==std::string::npos) return {};
    const auto last=s.find_last_not_of(" \t\r\n"); return s.substr(first,last-first+1);
}
std::uint16_t portValue(const std::string& s) { const auto n=std::stoul(s); if(n<1||n>65535) throw std::runtime_error("端口超出范围"); return static_cast<std::uint16_t>(n); }
void loadConfig(Config& c, const std::filesystem::path& path) {
    std::ifstream f(path); if(!f) throw std::runtime_error("无法打开配置文件");
    std::string line; while(std::getline(f,line)) { line=trim(line); if(line.empty()||line[0]=='#'||line[0]==';') continue;
        const auto p=line.find('='); if(p==std::string::npos) continue; auto k=trim(line.substr(0,p)); auto v=trim(line.substr(p+1));
        if(k=="public_bind") c.publicBind=v; else if(k=="public_port") c.publicPort=portValue(v);
        else if(k=="agent_bind") c.agentBind=v; else if(k=="agent_port") c.agentPort=portValue(v);
        else if(k=="shared_secret") c.secret=v; else if(k=="max_clients") c.maxClients=std::stoul(v);
        else if(k=="log_file") c.logFile=v;
    }
}

struct Wsa { Wsa(){ WSADATA d{}; if(WSAStartup(MAKEWORD(2,2),&d)!=0) throw std::runtime_error("WSAStartup 失败"); } ~Wsa(){WSACleanup();} };
void closeSocket(SOCKET& s) { const SOCKET old=std::exchange(s,INVALID_SOCKET); if(old!=INVALID_SOCKET){ shutdown(old,SD_BOTH); closesocket(old); } }
bool sendAll(SOCKET s,const std::uint8_t* p,std::size_t n) { while(n){ const int chunk=static_cast<int>((std::min)(n,static_cast<std::size_t>(INT_MAX))); const int r=send(s,reinterpret_cast<const char*>(p),chunk,0); if(r<=0)return false; p+=r;n-=r;} return true; }
bool recvAll(SOCKET s,std::uint8_t* p,std::size_t n) { while(n){ const int chunk=static_cast<int>((std::min)(n,static_cast<std::size_t>(INT_MAX))); const int r=recv(s,reinterpret_cast<char*>(p),chunk,0); if(r<=0)return false;p+=r;n-=r;} return true; }
SOCKET listenSocket(const std::string& host,std::uint16_t port) {
    addrinfo hints{}; hints.ai_family=AF_INET; hints.ai_socktype=SOCK_STREAM; hints.ai_protocol=IPPROTO_TCP; hints.ai_flags=AI_PASSIVE;
    addrinfo* result=nullptr; const auto ps=std::to_string(port); if(getaddrinfo(host.empty()?nullptr:host.c_str(),ps.c_str(),&hints,&result)!=0) return INVALID_SOCKET;
    SOCKET s=socket(result->ai_family,result->ai_socktype,result->ai_protocol); if(s==INVALID_SOCKET){freeaddrinfo(result);return s;}
    BOOL yes=TRUE; setsockopt(s,SOL_SOCKET,SO_REUSEADDR,reinterpret_cast<const char*>(&yes),sizeof(yes));
    if(bind(s,result->ai_addr,static_cast<int>(result->ai_addrlen))==SOCKET_ERROR||listen(s,SOMAXCONN)==SOCKET_ERROR){closeSocket(s);}
    freeaddrinfo(result); return s;
}
SOCKET connectSocket(const std::string& host,std::uint16_t port) {
    addrinfo hints{}; hints.ai_family=AF_UNSPEC; hints.ai_socktype=SOCK_STREAM; hints.ai_protocol=IPPROTO_TCP; addrinfo* result=nullptr;
    const auto ps=std::to_string(port); if(getaddrinfo(host.c_str(),ps.c_str(),&hints,&result)!=0)return INVALID_SOCKET;
    SOCKET s=INVALID_SOCKET; for(auto* a=result;a;a=a->ai_next){s=socket(a->ai_family,a->ai_socktype,a->ai_protocol);if(s!=INVALID_SOCKET&&connect(s,a->ai_addr,static_cast<int>(a->ai_addrlen))==0)break;closeSocket(s);} freeaddrinfo(result);return s;
}

struct Frame { Type type{}; std::uint32_t id{}; Bytes payload; };
void put32(std::uint8_t* p,std::uint32_t v){v=htonl(v);std::memcpy(p,&v,4);}
std::uint32_t get32(const std::uint8_t* p){std::uint32_t v;std::memcpy(&v,p,4);return ntohl(v);}
bool writeFrameUnlocked(SOCKET s,const Frame& f) {
    if(f.payload.size()>kMaxPayload)return false; std::array<std::uint8_t,16> h{}; put32(h.data(),kMagic);h[4]=kVersion;h[5]=static_cast<std::uint8_t>(f.type);put32(h.data()+8,f.id);put32(h.data()+12,static_cast<std::uint32_t>(f.payload.size()));
    return sendAll(s,h.data(),h.size())&&(f.payload.empty()||sendAll(s,f.payload.data(),f.payload.size()));
}
bool readFrame(SOCKET s,Frame& f) {
    std::array<std::uint8_t,16> h{};if(!recvAll(s,h.data(),h.size()))return false;
    if(get32(h.data())!=kMagic||h[4]!=kVersion||h[6]!=0||h[7]!=0)return false;
    const auto type=h[5];if(type<1||type>13)return false;const auto n=get32(h.data()+12);if(n>kMaxPayload)return false;
    f.type=static_cast<Type>(type);f.id=get32(h.data()+8);f.payload.resize(n);return n==0||recvAll(s,f.payload.data(),n);
}
Bytes randomBytes(std::size_t n){Bytes b(n);if(BCryptGenRandom(nullptr,b.data(),static_cast<ULONG>(b.size()),BCRYPT_USE_SYSTEM_PREFERRED_RNG)<0)throw std::runtime_error("随机数生成失败");return b;}
Bytes hmac(std::string_view key,const Bytes& challenge,std::string_view name){
    BCRYPT_ALG_HANDLE alg=nullptr;BCRYPT_HASH_HANDLE hash=nullptr;DWORD objSize=0,cb=0;Bytes out(32),data=challenge;data.insert(data.end(),name.begin(),name.end());data.insert(data.end(),{'C','P','R','2'});
    if(BCryptOpenAlgorithmProvider(&alg,BCRYPT_SHA256_ALGORITHM,nullptr,BCRYPT_ALG_HANDLE_HMAC_FLAG)<0)throw std::runtime_error("BCrypt 初始化失败");
    BCryptGetProperty(alg,BCRYPT_OBJECT_LENGTH,reinterpret_cast<PUCHAR>(&objSize),sizeof(objSize),&cb,0);Bytes object(objSize);
    const auto ok=BCryptCreateHash(alg,&hash,object.data(),objSize,reinterpret_cast<PUCHAR>(const_cast<char*>(key.data())),static_cast<ULONG>(key.size()),0)>=0&&
      BCryptHashData(hash,data.data(),static_cast<ULONG>(data.size()),0)>=0&&BCryptFinishHash(hash,out.data(),static_cast<ULONG>(out.size()),0)>=0;
    if(hash)BCryptDestroyHash(hash);if(alg)BCryptCloseAlgorithmProvider(alg,0);if(!ok)throw std::runtime_error("HMAC 计算失败");return out;
}
bool constantEqual(const Bytes& a,const Bytes& b){if(a.size()!=b.size())return false;std::uint8_t x=0;for(size_t i=0;i<a.size();++i)x|=a[i]^b[i];return x==0;}


Bytes creditBytes(std::uint64_t value){Bytes b(8);put32(b.data(),static_cast<std::uint32_t>(value>>32));put32(b.data()+4,static_cast<std::uint32_t>(value));return b;}
std::optional<std::uint64_t> readCredit(const Bytes& b){if(b.size()!=8)return {};return (std::uint64_t(get32(b.data()))<<32)|get32(b.data()+4);}

class PublicClient {
    SOCKET socket_; std::mutex mutex_; std::condition_variable ready_;
    Bytes ring_=Bytes(kWindow); std::uint64_t received_=0,consumed_=0,sent_=0,limit_=0;
    bool stopped_=false,remoteFin_=false,readDone_=false,writeDone_=false;
    std::size_t highWater_=0;
public:
    explicit PublicClient(SOCKET s):socket_(s){}
    ~PublicClient(){stop();closeSocket(socket_);}
    bool grant(std::uint64_t n){std::lock_guard lock(mutex_);if(n<limit_||n>sent_+kWindow)return false;limit_=n;ready_.notify_all();return true;}
    std::size_t allowance(){std::unique_lock lock(mutex_);ready_.wait(lock,[&]{return stopped_||sent_<limit_;});return stopped_?0:static_cast<std::size_t>((std::min)(std::uint64_t(kChunk),limit_-sent_));}
    void sent(std::size_t n){std::lock_guard lock(mutex_);sent_+=n;}
    bool enqueue(const Bytes& b){
        std::lock_guard lock(mutex_);if(stopped_||remoteFin_||b.empty()||b.size()>kChunk||received_-consumed_+b.size()>kWindow)return false;
        for(std::size_t i=0;i<b.size();++i)ring_[(received_+i)%kWindow]=b[i];received_+=b.size();highWater_=(std::max)(highWater_,static_cast<std::size_t>(received_-consumed_));ready_.notify_all();return true;
    }
    bool take(Bytes& b){
        std::unique_lock lock(mutex_);ready_.wait(lock,[&]{return stopped_||received_>consumed_||remoteFin_;});if(stopped_||received_==consumed_)return false;
        const auto n=static_cast<std::size_t>((std::min)(std::uint64_t(kChunk),received_-consumed_));b.resize(n);for(std::size_t i=0;i<n;++i)b[i]=ring_[(consumed_+i)%kWindow];return true;
    }
    std::uint64_t consumed(std::size_t n){std::lock_guard lock(mutex_);consumed_+=n;return consumed_+kWindow;}
    void finish(){std::lock_guard lock(mutex_);remoteFin_=true;ready_.notify_all();}
    bool done(bool reader){std::lock_guard lock(mutex_);if(reader)readDone_=true;else writeDone_=true;return readDone_&&writeDone_;}
    SOCKET socket(){std::lock_guard lock(mutex_);return stopped_?INVALID_SOCKET:socket_;}
    std::size_t highWater(){std::lock_guard lock(mutex_);return highWater_;}
    void stop(){SOCKET s;{std::lock_guard lock(mutex_);if(stopped_)return;stopped_=true;s=socket_;}ready_.notify_all();shutdown(s,SD_BOTH);}
};

class AgentSession : public std::enable_shared_from_this<AgentSession> {
    SOCKET socket_; std::mutex clientsMutex_,outputMutex_; std::condition_variable outputReady_;
    std::unordered_map<std::uint32_t,std::shared_ptr<PublicClient>> clients_;
    std::deque<Frame> commands_; std::unordered_map<std::uint32_t,Frame> credits_;
    std::unordered_map<std::uint32_t,std::deque<Frame>> data_; std::deque<std::uint32_t> ready_;
    std::size_t queued_=0; std::atomic<bool> alive_{true}; std::size_t maxClients_;
    std::string targetHost_; std::uint16_t targetPort_=0;
    std::atomic<std::int64_t> lastSeen_{std::chrono::steady_clock::now().time_since_epoch().count()};
public:
    AgentSession(SOCKET s,std::size_t maxClients,std::string targetHost={},std::uint16_t targetPort=0):socket_(s),maxClients_((std::min)(maxClients,std::size_t(128))),targetHost_(std::move(targetHost)),targetPort_(targetPort){}
    ~AgentSession(){stop();closeSocket(socket_);}
    bool alive()const{return alive_;}
    void startWriter(){std::thread([self=shared_from_this()]{self->writerLoop();}).detach();}
    bool sendFrame(Type t,std::uint32_t id=0,Bytes payload={}){
        bool overflow=false;
        {std::lock_guard lock(outputMutex_);if(!alive_)return false;
            if(t==Type::Credit)credits_.insert_or_assign(id,Frame{t,id,std::move(payload)});
            else if(t==Type::Data||t==Type::Fin){
                if(queued_+payload.size()>kSessionBudget)overflow=true;
                else {auto& q=data_[id];if(q.empty())ready_.push_back(id);queued_+=payload.size();q.push_back({t,id,std::move(payload)});}
            }else if(commands_.size()>=512)overflow=true;
            else commands_.push_back({t,id,std::move(payload)});
        }
        if(overflow){gLog.write("error","CPR2 aggregate queue invariant failed");stop();return false;}outputReady_.notify_one();return true;
    }
    bool addClient(std::uint32_t id,SOCKET s,std::uint64_t initialCredit=0){
        auto client=std::make_shared<PublicClient>(s);
        {std::lock_guard lock(clientsMutex_);if(!alive_||clients_.size()>=maxClients_||clients_.contains(id))return false;clients_[id]=client;}
        int buffer=static_cast<int>(kChunk);setsockopt(s,SOL_SOCKET,SO_SNDBUF,reinterpret_cast<const char*>(&buffer),sizeof(buffer));setsockopt(s,SOL_SOCKET,SO_RCVBUF,reinterpret_cast<const char*>(&buffer),sizeof(buffer));
        DWORD timeout=kPublicSendTimeoutMs;setsockopt(s,SOL_SOCKET,SO_SNDTIMEO,reinterpret_cast<const char*>(&timeout),sizeof(timeout));BOOL yes=TRUE;setsockopt(s,IPPROTO_TCP,TCP_NODELAY,reinterpret_cast<const char*>(&yes),sizeof(yes));
        if(initialCredit)client->grant(initialCredit);
        // OPEN/OPEN_OK must enter the scheduler before either data pump starts.
        sendFrame(initialCredit?Type::OpenOk:Type::Open,id,creditBytes(kWindow));
        std::thread([self=shared_from_this(),id,client]{self->writeClientLoop(id,client);}).detach();
        std::thread([self=shared_from_this(),id,client]{self->readClientLoop(id,client);}).detach();return true;
    }
    void removeClient(std::uint32_t id,bool reset=false,std::string_view reason="closed"){
        std::shared_ptr<PublicClient> client;
        {std::lock_guard lock(clientsMutex_);auto it=clients_.find(id);if(it==clients_.end())return;client=it->second;clients_.erase(it);}
        const auto water=client->highWater();client->stop();
        if(reset){std::lock_guard lock(outputMutex_);credits_.erase(id);auto it=data_.find(id);if(it!=data_.end()){for(const auto& f:it->second)queued_-=f.payload.size();data_.erase(it);}std::erase(ready_,id);}
        if(reset)sendFrame(Type::Close,id);
        gLog.write("info","tunnel="+std::to_string(id)+" reason="+std::string(reason)+" receive_high_water="+std::to_string(water));
    }
    void stop(){
        if(!alive_.exchange(false))return;shutdown(socket_,SD_BOTH);outputReady_.notify_all();
        std::vector<std::shared_ptr<PublicClient>> clients;{std::lock_guard lock(clientsMutex_);for(auto&[id,c]:clients_)clients.push_back(c);clients_.clear();}
        for(auto&c:clients)c->stop();
    }
    void readLoop(){
        Frame f;while(alive_&&readFrame(socket_,f)){
            lastSeen_=std::chrono::steady_clock::now().time_since_epoch().count();
            if(f.type==Type::Ping||f.type==Type::Pong){if(f.id||f.payload.size()>32)break;if(f.type==Type::Ping)sendFrame(Type::Pong,0,std::move(f.payload));continue;}
            if(!f.id)break;
            if(f.type==Type::Open&&targetPort_){
                auto limit=readCredit(f.payload);if(!limit||*limit!=kWindow)break;const auto id=f.id;
                std::thread([self=shared_from_this(),id]{SOCKET s=connectSocket(self->targetHost_,self->targetPort_);if(s==INVALID_SOCKET){self->sendFrame(Type::Close,id);return;}if(!self->addClient(id,s,kWindow))self->sendFrame(Type::Close,id);}).detach();continue;
            }
            std::shared_ptr<PublicClient> target;{std::lock_guard lock(clientsMutex_);auto it=clients_.find(f.id);if(it!=clients_.end())target=it->second;}if(!target)continue;
            if(f.type==Type::Data){if(!target->enqueue(f.payload))removeClient(f.id,true,"receive window violation");}
            else if(f.type==Type::OpenOk||f.type==Type::Credit){auto n=readCredit(f.payload);if(!n||!target->grant(*n))removeClient(f.id,true,"credit violation");}
            else if(f.type==Type::Fin&&f.payload.empty())target->finish();
            else if(f.type==Type::Close&&f.payload.size()<=1)removeClient(f.id,false,"peer reset");
            else {gLog.write("error","CPR2 invalid frame direction");break;}
        }stop();gLog.write("info","Agent disconnected; tunnels closed");
    }
    void heartbeatLoop(){while(alive_){std::this_thread::sleep_for(std::chrono::seconds(20));if(!alive_)break;const auto age=std::chrono::steady_clock::duration(std::chrono::steady_clock::now().time_since_epoch().count()-lastSeen_.load());if(age>std::chrono::seconds(60)){gLog.write("error","Agent heartbeat timeout");stop();break;}sendFrame(Type::Ping,0,randomBytes(8));}}
private:
    void writerLoop(){
        while(alive_){Frame f;{
            std::unique_lock lock(outputMutex_);outputReady_.wait(lock,[&]{return !alive_||!commands_.empty()||!credits_.empty()||!ready_.empty();});if(!alive_)break;
            if(!commands_.empty()){f=std::move(commands_.front());commands_.pop_front();}
            else if(!credits_.empty()){auto it=credits_.begin();f=std::move(it->second);credits_.erase(it);}
            else {auto id=ready_.front();ready_.pop_front();auto& q=data_.at(id);f=std::move(q.front());q.pop_front();if(q.empty())data_.erase(id);else ready_.push_back(id);}
        }
        if(!writeFrameUnlocked(socket_,f)){stop();break;}
        if(f.type==Type::Data){std::lock_guard lock(outputMutex_);queued_-=f.payload.size();}}
        // The reader still owns the socket until its blocking recv has returned.
    }
    void readClientLoop(std::uint32_t id,const std::shared_ptr<PublicClient>& c){
        Bytes buffer(kChunk);while(alive_){auto n=c->allowance();if(!n)return;const int got=recv(c->socket(),reinterpret_cast<char*>(buffer.data()),static_cast<int>(n),0);
            if(got<0){removeClient(id,true,"public read error");return;}
            if(got==0){sendFrame(Type::Fin,id);if(c->done(true))removeClient(id,false,"FIN drained");return;}
            c->sent(got);if(!sendFrame(Type::Data,id,Bytes(buffer.begin(),buffer.begin()+got)))return;
        }
    }
    void writeClientLoop(std::uint32_t id,const std::shared_ptr<PublicClient>& c){
        Bytes payload;while(c->take(payload)){if(!sendAll(c->socket(),payload.data(),payload.size())){removeClient(id,true,"public write error or idle timeout");return;}sendFrame(Type::Credit,id,creditBytes(c->consumed(payload.size())));}
        const auto s=c->socket();if(s!=INVALID_SOCKET){shutdown(s,SD_SEND);if(c->done(false))removeClient(id,false,"FIN drained");}
    }
};

bool authenticateServer(SOCKET s,const Config& c,std::string& agentName){
    DWORD timeout=10000;setsockopt(s,SOL_SOCKET,SO_RCVTIMEO,reinterpret_cast<const char*>(&timeout),sizeof(timeout));setsockopt(s,SOL_SOCKET,SO_SNDTIMEO,reinterpret_cast<const char*>(&timeout),sizeof(timeout));
    Frame f;if(!readFrame(s,f)||f.type!=Type::Hello||f.id!=0||f.payload.empty()||f.payload.size()>64)return false;
    agentName.assign(f.payload.begin(),f.payload.end());const auto challenge=randomBytes(32);if(!writeFrameUnlocked(s,{Type::Challenge,0,challenge}))return false;
    if(!readFrame(s,f)||f.type!=Type::Auth||f.id!=0||f.payload.size()!=32)return false;const auto expected=hmac(c.secret,challenge,agentName);
    if(!constantEqual(f.payload,expected)){const std::string e="authentication failed";writeFrameUnlocked(s,{Type::Error,0,Bytes(e.begin(),e.end())});return false;}
    if(!writeFrameUnlocked(s,{Type::AuthOk,0,{}}))return false;timeout=0;setsockopt(s,SOL_SOCKET,SO_RCVTIMEO,reinterpret_cast<const char*>(&timeout),sizeof(timeout));setsockopt(s,SOL_SOCKET,SO_SNDTIMEO,reinterpret_cast<const char*>(&timeout),sizeof(timeout));BOOL keepalive=TRUE;setsockopt(s,SOL_SOCKET,SO_KEEPALIVE,reinterpret_cast<const char*>(&keepalive),sizeof(keepalive));return true;
}

class Server {
    Config config_; SOCKET publicListener_=INVALID_SOCKET,agentListener_=INVALID_SOCKET; std::atomic<bool> stopping_{false}; std::mutex agentMutex_; std::shared_ptr<AgentSession> agent_; std::atomic<std::uint32_t> nextId_{1}; std::thread agentAcceptThread_,publicAcceptThread_;
public:
    explicit Server(Config c):config_(std::move(c)){}
    bool start(){
        publicListener_=listenSocket(config_.publicBind,config_.publicPort);agentListener_=listenSocket(config_.agentBind,config_.agentPort);
        if(publicListener_==INVALID_SOCKET||agentListener_==INVALID_SOCKET){stop();return false;}
        gLog.write("信息","公开端口 "+std::to_string(config_.publicPort)+"，Agent 端口 "+std::to_string(config_.agentPort)+" 已监听");
        agentAcceptThread_=std::thread(&Server::agentAcceptLoop,this);publicAcceptThread_=std::thread(&Server::publicAcceptLoop,this);return true;
    }
    void wait(){while(!stopping_)std::this_thread::sleep_for(std::chrono::milliseconds(250));}
    void stop(){if(stopping_.exchange(true))return;closeSocket(publicListener_);closeSocket(agentListener_);std::shared_ptr<AgentSession> a;{std::lock_guard lock(agentMutex_);a=std::exchange(agent_,{});}if(a)a->stop();if(agentAcceptThread_.joinable()&&agentAcceptThread_.get_id()!=std::this_thread::get_id())agentAcceptThread_.join();if(publicAcceptThread_.joinable()&&publicAcceptThread_.get_id()!=std::this_thread::get_id())publicAcceptThread_.join();}
private:
    void agentAcceptLoop(){while(!stopping_){SOCKET s=accept(agentListener_,nullptr,nullptr);if(s==INVALID_SOCKET)break;std::string name;if(!authenticateServer(s,config_,name)){gLog.write("警告","拒绝未通过认证的 Agent");closeSocket(s);continue;}
        auto session=std::make_shared<AgentSession>(s,config_.maxClients);session->startWriter();std::shared_ptr<AgentSession> old;{std::lock_guard lock(agentMutex_);old=std::exchange(agent_,session);}if(old)old->stop();gLog.write("信息","Agent 已连接："+name);std::thread([session]{session->readLoop();}).detach();std::thread([session]{session->heartbeatLoop();}).detach();}}
    void publicAcceptLoop(){while(!stopping_){SOCKET s=accept(publicListener_,nullptr,nullptr);if(s==INVALID_SOCKET)break;std::shared_ptr<AgentSession> a;{std::lock_guard lock(agentMutex_);a=agent_;}
        if(!a||!a->alive()){closeSocket(s);continue;}auto id=nextId_.fetch_add(1);if(id==0)id=nextId_.fetch_add(1);
        if(!a->addClient(id,s))continue;}}

};


int runTestAgent(const std::string& server,std::uint16_t agentPort,const std::string& secret,const std::string& targetHost,std::uint16_t targetPort){
    SOCKET control=connectSocket(server,agentPort);if(control==INVALID_SOCKET)return 2;
    const std::string name="cpp-test-agent";writeFrameUnlocked(control,{Type::Hello,0,Bytes(name.begin(),name.end())});Frame f;
    if(!readFrame(control,f)||f.type!=Type::Challenge||!writeFrameUnlocked(control,{Type::Auth,0,hmac(secret,f.payload,name)})||!readFrame(control,f)||f.type!=Type::AuthOk){closeSocket(control);return 3;}
    auto session=std::make_shared<AgentSession>(control,128,targetHost,targetPort);session->startWriter();gLog.write("info","Test Agent connected using CPR2");session->readLoop();return 0;
}
int runEchoServer(std::uint16_t port){SOCKET listener=listenSocket("127.0.0.1",port);if(listener==INVALID_SOCKET)return 2;gLog.write("信息","测试回显端口已监听："+std::to_string(port));for(;;){SOCKET client=accept(listener,nullptr,nullptr);if(client==INVALID_SOCKET)break;std::thread([client]() mutable {std::array<std::uint8_t,16384>b{};for(;;){const int n=recv(client,reinterpret_cast<char*>(b.data()),static_cast<int>(b.size()),0);if(n<=0||!sendAll(client,b.data(),n))break;}closeSocket(client);}).detach();}closeSocket(listener);return 0;}

std::atomic<Server*> gServer=nullptr;BOOL WINAPI consoleHandler(DWORD type){if(type==CTRL_C_EVENT||type==CTRL_BREAK_EVENT||type==CTRL_CLOSE_EVENT){if(auto*s=gServer.load())s->stop();return TRUE;}return FALSE;}
SERVICE_STATUS_HANDLE gStatusHandle=nullptr;SERVICE_STATUS gStatus{};std::unique_ptr<Server> gServiceServer;
void setServiceState(DWORD state,DWORD error=NO_ERROR){gStatus.dwServiceType=SERVICE_WIN32_OWN_PROCESS;gStatus.dwCurrentState=state;gStatus.dwControlsAccepted=state==SERVICE_RUNNING?SERVICE_ACCEPT_STOP|SERVICE_ACCEPT_SHUTDOWN:0;gStatus.dwWin32ExitCode=error;SetServiceStatus(gStatusHandle,&gStatus);}
void WINAPI serviceControl(DWORD code){if((code==SERVICE_CONTROL_STOP||code==SERVICE_CONTROL_SHUTDOWN)&&gServiceServer){setServiceState(SERVICE_STOP_PENDING);gServiceServer->stop();}}

Config parseConfig(int argc,wchar_t** argv,int start){Config c;std::optional<std::filesystem::path> file;for(int i=start;i<argc;++i)if(std::wstring_view(argv[i])==L"--config"&&i+1<argc)file=argv[++i];if(file)loadConfig(c,*file);
    for(int i=start;i<argc;++i){std::wstring k=argv[i];auto val=[&]()->std::wstring{if(i+1>=argc)throw std::runtime_error("参数缺少值");return argv[++i];};
        if(k==L"--config")++i;else if(k==L"--public-bind"){auto w=val();c.publicBind=std::filesystem::path(w).string();}else if(k==L"--public-port")c.publicPort=portValue(std::filesystem::path(val()).string());
        else if(k==L"--agent-bind"){auto w=val();c.agentBind=std::filesystem::path(w).string();}else if(k==L"--agent-port")c.agentPort=portValue(std::filesystem::path(val()).string());
        else if(k==L"--secret"){auto w=val();c.secret=std::filesystem::path(w).string();}else if(k==L"--max-clients")c.maxClients=std::stoul(val());else if(k==L"--log")c.logFile=val();}
    if(c.secret.size()<32||c.secret.rfind("CHANGE_ME",0)==0)throw std::runtime_error("shared_secret 至少需要 32 个字符且不能使用示例值");if(c.maxClients<1||c.maxClients>4096)throw std::runtime_error("max_clients 必须为 1..4096");return c;
}
std::vector<std::wstring> commandLineArgs(){int n=0;LPWSTR* p=CommandLineToArgvW(GetCommandLineW(),&n);std::vector<std::wstring> a;if(p){for(int i=0;i<n;++i)a.emplace_back(p[i]);LocalFree(p);}return a;}
void WINAPI serviceMain(DWORD,wchar_t**){gStatusHandle=RegisterServiceCtrlHandlerW(kServiceName,serviceControl);if(!gStatusHandle)return;setServiceState(SERVICE_START_PENDING);try{auto a=commandLineArgs();std::vector<wchar_t*> p;for(auto&s:a)p.push_back(s.data());Config c=parseConfig(static_cast<int>(p.size()),p.data(),2);gLog.open(c.logFile);gServiceServer=std::make_unique<Server>(std::move(c));if(!gServiceServer->start()){setServiceState(SERVICE_STOPPED,ERROR_SERVICE_SPECIFIC_ERROR);return;}setServiceState(SERVICE_RUNNING);gServiceServer->wait();setServiceState(SERVICE_STOPPED);}catch(...){setServiceState(SERVICE_STOPPED,ERROR_SERVICE_SPECIFIC_ERROR);}}

std::wstring quote(const std::wstring& s){return L"\""+s+L"\"";}
int installService(int argc,wchar_t** argv){wchar_t exe[MAX_PATH];GetModuleFileNameW(nullptr,exe,MAX_PATH);std::wstring cmd=quote(exe)+L" service";for(int i=2;i<argc;++i)cmd+=L" "+quote(argv[i]);
    SC_HANDLE scm=OpenSCManagerW(nullptr,nullptr,SC_MANAGER_CREATE_SERVICE);if(!scm){std::wcerr<<L"无法打开服务管理器，需管理员权限\n";return 2;}SC_HANDLE svc=CreateServiceW(scm,kServiceName,L"Codex Phone Relay",SERVICE_ALL_ACCESS,SERVICE_WIN32_OWN_PROCESS,SERVICE_AUTO_START,SERVICE_ERROR_NORMAL,cmd.c_str(),nullptr,nullptr,nullptr,nullptr,nullptr);
    if(!svc){std::wcerr<<L"安装失败，错误码 "<<GetLastError()<<L"\n";CloseServiceHandle(scm);return 3;}SERVICE_DESCRIPTIONW d{const_cast<LPWSTR>(L"Codex 手机透明 TCP 中继服务")};ChangeServiceConfig2W(svc,SERVICE_CONFIG_DESCRIPTION,&d);CloseServiceHandle(svc);CloseServiceHandle(scm);std::wcout<<L"服务安装成功：CodexPhoneRelay\n";return 0;}
int uninstallService(){SC_HANDLE scm=OpenSCManagerW(nullptr,nullptr,SC_MANAGER_CONNECT);if(!scm)return 2;SC_HANDLE svc=OpenServiceW(scm,kServiceName,DELETE|SERVICE_STOP);if(!svc){CloseServiceHandle(scm);return 3;}SERVICE_STATUS s{};ControlService(svc,SERVICE_CONTROL_STOP,&s);const BOOL ok=DeleteService(svc);CloseServiceHandle(svc);CloseServiceHandle(scm);if(!ok)return 4;std::wcout<<L"服务已卸载\n";return 0;}
}

int wmain(int argc,wchar_t** argv){
    using namespace relay;try{Wsa wsa;if(argc<2){std::wcout<<L"用法：relay-server run|service|install|uninstall|test-agent|echo-server [参数]\n";return 1;}const std::wstring mode=argv[1];
        if(mode==L"install")return installService(argc,argv);if(mode==L"uninstall")return uninstallService();
        if(mode==L"service"){SERVICE_TABLE_ENTRYW table[]={{const_cast<LPWSTR>(kServiceName),serviceMain},{nullptr,nullptr}};return StartServiceCtrlDispatcherW(table)?0:static_cast<int>(GetLastError());}
        if(mode==L"echo-server"){std::uint16_t port=18888;for(int i=2;i<argc;++i)if(std::wstring_view(argv[i])==L"--port"&&i+1<argc)port=portValue(std::filesystem::path(argv[++i]).string());return runEchoServer(port);}
        if(mode==L"test-agent"){std::string server="127.0.0.1",secret,target="127.0.0.1";std::uint16_t ap=8789,tp=18888;for(int i=2;i<argc;++i){std::wstring k=argv[i];auto v=[&](){if(++i>=argc)throw std::runtime_error("参数缺少值");return std::filesystem::path(argv[i]).string();};if(k==L"--server")server=v();else if(k==L"--agent-port")ap=portValue(v());else if(k==L"--secret")secret=v();else if(k==L"--target")target=v();else if(k==L"--target-port")tp=portValue(v());}if(secret.empty())throw std::runtime_error("缺少 --secret");return runTestAgent(server,ap,secret,target,tp);}
        if(mode!=L"run")throw std::runtime_error("未知运行模式");Config c=parseConfig(argc,argv,2);gLog.open(c.logFile);Server server(std::move(c));gServer=&server;SetConsoleCtrlHandler(consoleHandler,TRUE);if(!server.start()){std::cerr<<"监听端口失败，错误码 "<<WSAGetLastError()<<"\n";return 2;}server.wait();gServer=nullptr;return 0;
    }catch(const std::exception& e){std::cerr<<"错误："<<e.what()<<"\n";return 1;}}
