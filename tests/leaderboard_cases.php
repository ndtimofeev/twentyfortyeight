<?php
// Loaded by backend.php, using the real services with SQLite adapters.
use OCA\TwentyFortyEight\Service\LeaderboardService;
use OCA\TwentyFortyEight\Notification\Notifier;
use TwentyFortyEightTests\Notifications;
use TwentyFortyEightTests\Logger;

$tests['leader displacement notifies all tied leaders but never the winning user'] = function (): void {
	[$db, $mapper] = fixture();
	$notifications = new Notifications($db);
	$service = new LeaderboardService($mapper, $notifications, new Logger());
	$service->store('alice', 100, 16, 5, 1);
	$service->store('bob', 100, 16, 5, 2);
	same([], $notifications->stored());
	$service->store('carol', 200, 32, 10, 3);
	$sent = $notifications->stored();
	same(['alice','bob'], array_column($sent, 'user'));
	same('leader_lost', $sent[0]['subject']);
	same(['user'=>'carol','score'=>200], $sent[0]['subjectParameters']);
	$service->store('carol', 220, 64, 11, 4);
	$service->store('carol', 220, 64, 11, 4); // Lost response / retry.
	$service->store('alice', 100, 128, 5, 5); // Tile record only.
	$service->store('alice', 200, 128, 10, 6); // Still below first place.
	$service->store('alice', 220, 128, 11, 7); // A tie shares first place.
	same(2, count($notifications->stored()));
	$service->store('alice', 300, 128, 15, 8);
	$sent = $notifications->stored();
	same(3, count($sent));
	same('carol', $sent[2]['user']);
	same(['user'=>'alice','score'=>300], $sent[2]['subjectParameters']);
};

$tests['notifications cover tied leaders outside the displayed top twenty'] = function (): void {
	[$db, $mapper] = fixture();
	for ($i=0;$i<25;$i++) $mapper->storeBest('user-'.$i, 100, 16, 5, 1);
	$notifications = new Notifications($db);
	(new LeaderboardService($mapper, $notifications, new Logger()))->store('winner', 200, 32, 10, 2);
	same(25, count($notifications->stored()));
};

$tests['record and notification failures roll back together and retry produces one event'] = function (): void {
	[$db, $mapper] = fixture();
	$mapper->storeBest('alice', 100, 16, 5, 1);
	$notifications = new Notifications($db);
	$notifications->fail = true;
	$service = new LeaderboardService($mapper, $notifications, new Logger());
	try { $service->store('bob', 200, 32, 10, 2); throw new LogicException('Expected notification failure'); }
	catch (RuntimeException $e) { same('Notification insert failed', $e->getMessage()); }
	same(null, $mapper->findByUser('bob'));
	same([], $notifications->stored());
	same(0, $notifications->flushes);
	$notifications->fail = false;
	$notifications->deferred = false; // A fresh HTTP request owns its deferral.
	$service->store('bob', 200, 32, 10, 2);
	$service->store('bob', 200, 32, 10, 2);
	same(1, count($notifications->stored()));
	same(2, $notifications->flushes);
};

$tests['standard notifier renders safe text links and a fallback for a deleted winner'] = function (): void {
	$users = new class implements OCP\IUserManager {
		public function get(string $uid): ?OCP\IUser { return $uid === 'gone' ? null : new TwentyFortyEightTests\User('<winner>'); }
	};
	$notifier = new Notifier(new TwentyFortyEightTests\Translations(), new TwentyFortyEightTests\Urls(), $users);
	$notification = (new Notifications())->createNotification()->setApp('twentyfortyeight')->setSubject('leader_lost',['user'=>'alice','score'=>200]);
	$notifier->prepare($notification, 'en');
	same('You lost first place in 2048', $notification->getParsedSubject());
	same('<winner> overtook you with 200 points.', $notification->getParsedMessage());
	same('https://cloud.test/apps/twentyfortyeight/', $notification->getLink());
	same('https://cloud.test/apps/twentyfortyeight/img/app.svg', $notification->getIcon());
	$notification->setSubject('leader_lost',['user'=>'gone','score'=>300]);
	$notifier->prepare($notification, 'en');
	same('Another player overtook you with 300 points.', $notification->getParsedMessage());
	invalid(fn() => $notifier->prepare($notification->setApp('other'), 'en'));
};

$tests['v5 nested cutovers preserve a v4 offline double-bonus history and allow two future Undo'] = function (): void {
	[, $mapper, $sessions, $service, $clock] = activeFixture();
	$p1=legacySession('alice',$clock,1);
	$p2=signedPayload('alice',['v'=>2,'s'=>1,'iat'=>$clock->now,'p'=>$p1['token']]);
	$p3=signedPayload('alice',['v'=>3,'s'=>1,'iat'=>$clock->now,'p'=>$p2,'n'=>1]);
	$p4=signedPayload('alice',['v'=>4,'s'=>1,'iat'=>$clock->now,'p'=>$p3,'n'=>1]);
	$prefix=[['move',0]];
	$old=$sessions->verify('alice',$p4,$prefix,true);
	same(true,$mapper->insert('alice',['session'=>$old['session'],'actions'=>$prefix,'revision'=>7,'state'=>$old['savedState']],$clock->now));
	$target=$service->get('alice');
	same(5,$target['session']['version']);
	same([$p3,$p2,$p1['token']],$target['session']['ancestorTokens']);
	same([1,1,1],$target['session']['ancestorCutovers']);
	same(true,strlen($target['session']['token'])>512);
	same(true,strlen($target['session']['token'])<=2048);
	$tail=[...$prefix,['swap',0,0,0,3],['remove',2]];
	$saved=$service->save('alice',$target['session']['token'],$tail,8,$p4,$p4);
	sameCutoverState($sessions->verify('alice',$p4,$tail,true)['savedState'],$saved['state']);
	// Old v4 removes its earlier snapshot; its already played actions stay v4.
	same(false,isset($saved['state']['previous']['previous']));
	$new=[...$tail,['move',1],['remove',4],['undo'],['undo']];
	$modern=$service->save('alice',$saved['session']['token'],$new,9);
	sameGame($saved['state']['grid'],$modern['state']['grid']);
	same(0,$modern['state']['bonuses']['undo']);
	same(null,$modern['state']['previous']);
	invalid(fn()=>$sessions->verify('alice',$p4,[...$tail,['undo'],['undo']]));
};

$tests['v5 extends every unplayed boundary for an older ancestor and rejects a played inner suffix'] = function (): void {
	[, $mapper, $sessions, $service, $clock] = activeFixture();
	[$prefix,$full]=bankDependentV2History();
	$p1=legacySession('alice',$clock);
	$p2=signedPayload('alice',['v'=>2,'s'=>42,'iat'=>$clock->now,'p'=>$p1['token']]);
	$p3=signedPayload('alice',['v'=>3,'s'=>42,'iat'=>$clock->now,'p'=>$p2,'n'=>count($prefix)]);
	$p4=signedPayload('alice',['v'=>4,'s'=>42,'iat'=>$clock->now,'p'=>$p3,'n'=>count($prefix)]);
	$old=$sessions->verify('alice',$p4,$prefix,true);
	$mapper->insert('alice',['session'=>$old['session'],'actions'=>$prefix,'revision'=>7,'state'=>$old['savedState']],$clock->now);
	$target=$service->get('alice');
	$saved=$service->save('alice',$target['session']['token'],$full,8,$p4,$p2);
	same([count($full),count($full),count($full)],$saved['session']['ancestorCutovers']);
	sameCutoverState($sessions->verify('alice',$p2,$full,true)['savedState'],$saved['state']);
	sameGame($saved,$service->save('alice',$target['session']['token'],$full,8,$p4,$p2));
	$played=[...$prefix,['undo']];
	$played4=signedPayload('alice',['v'=>4,'s'=>42,'iat'=>$clock->now,'p'=>$p3,'n'=>count($played)]);
	$blocked=$sessions->upgrade('alice',$played4,$played);
	same(true,$blocked['ancestorCutovers'][1] < $blocked['cutover']);
	invalid(fn()=>$sessions->extendUpgrade('alice',$blocked['token'],$played4,$full,$p2));
};

$tests['v5 longest signed ancestry fits the widened token column'] = function (): void {
	[$db, , $schema]=fixture();
	$clock=new TwentyFortyEightTests\Clock();
	$sessions=new OCA\TwentyFortyEight\Game\GameSession(new TwentyFortyEightTests\Config(),$clock);
	$parent=null;
	foreach (range(1,5) as $v) {
		$data=['v'=>$v,'s'=>0xffffffff,'iat'=>$clock->now];
		if ($parent!==null) { $data['p']=$parent; if ($v>=3) $data['n']=50000; }
		$parent=signedPayload('alice',$data);
	}
	same(5,$sessions->session('alice',$parent)['version']);
	same(true,strlen($parent)>1024);
	same(true,strlen($parent)<=2048);
	same(2048,$schema->getTable('twentyfortyeight_games')->getColumn('session_token')->getLength());
	$migration=new OCA\TwentyFortyEight\Migration\Version000700Date20261016000000($db);
	$output=new class implements OCP\Migration\IOutput {};
	same(null,$migration->changeSchema($output,fn()=>$schema,[]));
	$migration->postSchemaChange($output,fn()=>$schema,[]);
	same(1,(int)$db->pdo->query('SELECT COUNT(*) FROM twentyfortyeight_leader_lock')->fetchColumn());
};
