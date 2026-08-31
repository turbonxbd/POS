<?php
declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

foreach (glob(__DIR__ . '/*_test.php') as $file) {
    fwrite(STDOUT, "\n" . basename($file) . "\n");
    require $file;
}

$r = $GLOBALS['__afia_tests'];
fwrite(STDOUT, "\n===== {$r['pass']} passed, {$r['fail']} failed =====\n");
exit($r['fail'] > 0 ? 1 : 0);
